import os
import csv
import threading
import subprocess
import json
from flask import Flask, jsonify, request, send_from_directory
from flask_socketio import SocketIO
from confluent_kafka import Producer, Consumer, KafkaError
from confluent_kafka.admin import AdminClient, NewTopic
from google.cloud import secretmanager

# --- Helper Functions ---

def get_secret(project_id, secret_id, version_id="latest"):
    """Retrieves a secret from Google Cloud Secret Manager."""
    client = secretmanager.SecretManagerServiceClient()
    name = f"projects/{project_id}/secrets/{secret_id}/versions/{version_id}"
    response = client.access_secret_version(request={"name": name})
    return response.payload.data.decode("UTF-8")

def create_topic_if_not_exists(admin_client, topic_name, num_partitions=6):
    print(f"Checking if topic '{topic_name}' exists...")
    cluster_metadata = admin_client.list_topics(timeout=5)
    if topic_name in cluster_metadata.topics:
        print(f"Topic '{topic_name}' already exists.")
        return

    print(f"Creating topic '{topic_name}' with {num_partitions} partitions...")
    new_topic = NewTopic(topic_name, num_partitions=num_partitions, replication_factor=3)
    fs = admin_client.create_topics([new_topic])

    for topic, f in fs.items():
        try:
            f.result()
            print(f"Topic '{topic}' created.")
        except Exception as e:
            if e.args[0].code() == KafkaError.TOPIC_ALREADY_EXISTS:
                print(f"Topic '{topic}' already exists.")
            else:
                raise RuntimeError(f"Failed to create topic {topic}: {e}")

def load_and_group_data(csv_path):
    data_by_surface_id = {}
    print(f"Loading data from '{csv_path}'...")
    try:
        with open(csv_path, newline='') as csvfile:
            reader = csv.reader(csvfile)
            next(reader)  # Skip header
            for row in reader:
                if not row: continue
                surface_id = row[0]
                data_by_surface_id.setdefault(surface_id, []).append(row)
        print("Data loaded successfully.")
    except FileNotFoundError:
        print(f"Error: File '{csv_path}' not found.")
        return None
    return data_by_surface_id

# --- Global Setup ---

# 1. Determine the path to your files based on your screenshot
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "Web Dashboard") # <--- Points to your subfolder

print(f"--- SERVER INFO ---")
print(f"Server script is in: {BASE_DIR}")
print(f"Serving Website from: {WEB_DIR}")
print(f"-------------------")

# GCP Project ID
try:
    project_id = os.environ["GOOGLE_CLOUD_PROJECT"]
except KeyError:
    try:
        project_id = subprocess.check_output(["gcloud", "config", "get-value", "project"], text=True).strip()
    except Exception as e:
        raise RuntimeError("Could not determine project ID.") from e

# Config
bootstrap_server = "pkc-619z3.us-east1.gcp.confluent.cloud:9092"
inbound_topic = "my-topic"
outbound_topic = "robot-actions"
raw_predictions_topic = "raw-predictions" # Topic for raw ML output
partitions = 6

# --- Dataset Citation ---
# Ahmadi, Reza; Nygaard, Tønnes; Kottege, Navinda; Howard, David; & Hudson, Nicolas (2020): 
# QCAT legged robot terrain classification dataset. v2. CSIRO. Data Collection. 
# https://doi.org/10.25919/5f88b9c730442
# ------------------------
csv_file_path = os.path.join(BASE_DIR, "AI_Partner_Hackathon_QCAT - Sheet1.csv")

# Credentials
print("Fetching credentials...")
api_key = get_secret(project_id, "confluent-api-key")
api_secret = get_secret(project_id, "confluent-api-secret")

# Kafka Producer Config
config = {
    'bootstrap.servers': 'kafka:9092',
    'client.id': socket.gethostname()
}

# Init Kafka
admin_client = AdminClient(config)
create_topic_if_not_exists(admin_client, inbound_topic, partitions)
data_by_surface_id = load_and_group_data(csv_file_path)
producer = Producer(config)

# State Management
next_indices = {key: 0 for key in data_by_surface_id.keys()} if data_by_surface_id else {}
lock = threading.Lock()

def delivery_report(err, msg):
    if err is not None:
        print(f"Delivery failed: {err}")
    else:
        print(f"Delivered to {msg.topic()} [{msg.partition()}]")

# --- Flask Server ---
# We tell Flask to look in the WEB_DIR for the static files
app = Flask(__name__, static_folder=WEB_DIR, static_url_path='')
# async_mode='threading' is important for running the consumer in a background thread
socketio = SocketIO(app, cors_allowed_origins="*")

@app.route('/')
def index():
    # Verify file exists to give a clear error if the folder name is wrong
    file_path = os.path.join(WEB_DIR, 'index.html')
    if not os.path.exists(file_path):
        return f"<h1>Error: index.html not found</h1><p>Looking in: {file_path}</p><p>Check if the folder name 'Web Dashboard' matches exactly.</p>", 404
    return send_from_directory(WEB_DIR, 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory(WEB_DIR, path)

@app.route("/produce/<int:surface_id>", methods=["POST"])
def produce_message(surface_id):
    start_time = request.args.get('startTime') # Get timestamp from query params
    surface_id_str = str(surface_id)

    if not data_by_surface_id or surface_id_str not in data_by_surface_id:
        return jsonify({"status": "error", "message": "No data found"}), 404

    with lock:
        all_rows = data_by_surface_id[surface_id_str]
        current_index = next_indices[surface_id_str]
        row_data = all_rows[current_index]
        next_indices[surface_id_str] = (current_index + 1) % len(all_rows)

    key = row_data[0]
    vibration_data = ",".join(row_data[1:])

    # Create a JSON payload to include the start time
    payload = {
        "vibration_data": vibration_data,
        "start_time": start_time
    }
    value_data = json.dumps(payload)
    print(f"Producing for Surface {key}...")
    producer.produce(inbound_topic, key=key, value=value_data, callback=delivery_report)
    producer.poll(0)

    return jsonify({"status": "success", "sent_key": key, "sent_value": value_data})

# --- Kafka Consumer for Robot Actions (Feedback Loop) ---
def consume_robot_actions():
    """Runs in a background thread to consume action commands and push them to the client."""
    consumer_config = config.copy()
    consumer_config.update({
        'group.id': 'robot-action-consumer-group',
        'auto.offset.reset': 'latest' # We only care about new commands
    })
    consumer = Consumer(consumer_config)
    consumer.subscribe([outbound_topic, raw_predictions_topic])
    print(f"Subscribed to '{outbound_topic}' and '{raw_predictions_topic}'.")

    while True:
        msg = consumer.poll(1.0)
        if msg is None or msg.value() is None:
            continue
        if msg.error():
            print(f"Action consumer error: {msg.error()}")
            continue

        action_str = msg.value().decode('utf-8')
        print(f"Received action command: {action_str}")
        topic = msg.topic()

        try:
            try:
                action_data = json.loads(action_str)
            except json.JSONDecodeError:
                action_data = eval(action_str)

            if topic == outbound_topic:
                # This is a CONFIRMED action
                socketio.emit('robot_action', action_data)
                print(f"  -> Emitted CONFIRMED '{action_data.get('gait')}' action to dashboard.")
            elif topic == raw_predictions_topic:
                # This is a RAW, unconfirmed prediction
                socketio.emit('raw_prediction', action_data)
                print(f"  -> Emitted RAW '{action_data.get('gait')}' prediction to dashboard.")

        except json.JSONDecodeError as e:
            print(f"  -> Error decoding action JSON: {e}")
        except Exception as e:
            print(f"  -> An unexpected error occurred: {e}")


if __name__ == "__main__":
    # Start the Kafka consumer in a background thread
    action_consumer_thread = threading.Thread(target=consume_robot_actions, daemon=True)
    action_consumer_thread.start()

    print("Starting Flask-SocketIO server on port 5000...")
    # Use socketio.run() instead of app.run()
    socketio.run(app, host='0.0.0.0', port=5000)
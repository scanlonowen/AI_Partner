import os
from confluent_kafka import Consumer, Producer, KafkaError, KafkaException
from confluent_kafka.admin import AdminClient, NewTopic
import json
import subprocess
from google.cloud import secretmanager
from google.cloud import aiplatform


def get_secret(project_id, secret_id, version_id="latest"):
    """
    Retrieves a secret from Google Cloud Secret Manager.
    """
    client = secretmanager.SecretManagerServiceClient()
    name = f"projects/{project_id}/secrets/{secret_id}/versions/{version_id}"
    response = client.access_secret_version(request={"name": name})
    return response.payload.data.decode("UTF-8")

def create_topic_if_not_exists(admin_client, topic_name, num_partitions=1):
    """Checks if a topic exists and creates it if it doesn't."""
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

def main():
    """
    Connects to Confluent Cloud and consumes messages from a Kafka topic.
    """
    # --- Configuration ---
    # Your GCP Project ID
    try:
        project_id = os.environ["GOOGLE_CLOUD_PROJECT"]
    except KeyError:
        print("GOOGLE_CLOUD_PROJECT environment variable not set. Trying to get from gcloud config.")
        try:
            project_id = subprocess.check_output(
                ["gcloud", "config", "get-value", "project"], text=True
            ).strip()
        except (subprocess.CalledProcessError, FileNotFoundError) as e:
            raise RuntimeError("Could not determine project ID. Please set the GOOGLE_CLOUD_PROJECT environment variable.") from e

    # Your Confluent Cloud bootstrap server
    bootstrap_server = "pkc-619z3.us-east1.gcp.confluent.cloud:9092"
    # Kafka topics
    inbound_topic = "my-topic"
    outbound_topic = "robot-actions" # New topic for sending commands back to the robot
    raw_predictions_topic = "raw-predictions" # New topic for instant ML output

    # Consumer group ID (important for Kafka consumers)
    group_id = "my-python-consumer-group-2" # Changed to reset the consumer for testing

    # --- Vertex AI Configuration ---
    # TODO: Replace with your Vertex AI Endpoint ID and Location
    vertex_ai_endpoint_id = "7827272645044338688"
    vertex_ai_location = "us-central1" # e.g., "us-central1"

    # The feature names your model was trained on.
    # The order MUST match the order of columns in your CSV data.
    feature_names = [
        "FL_x", "FL_y", "FL_z",
        "FR_x", "FR_y", "FR_z",
        "BR_x", "BR_y", "BR_z",
        "BL_x", "BL_y", "BL_z"
    ]

    # --- Output Formatting Configuration ---
    # Map class IDs from the model to human-readable names
    surface_map = {
        '0': 'Concrete',
        '1': 'Grass',
        '2': 'Gravel',
        '3': 'Mulch',
        '4': 'Dirt',
        '5': 'Sand',
    }

    # ANSI color codes for terminal output
    colors = {
        'Concrete': '\033[90m', 'Grass': '\033[92m', 'Gravel': '\033[94m',
        'Mulch': '\033[95m', 'Dirt': '\033[93m', 'Sand': '\033[96m',
        'ENDC': '\033[0m' # Reset color
    }

    # --- Action Command Mapping ---
    # Structured commands to be sent to the robot simulator
    action_commands = {
        'Concrete': {"gait": "Concrete", "speed_modifier": 1.0},  # Fastest
        'Grass':    {"gait": "Grass",    "speed_modifier": 1.25},
        'Gravel':   {"gait": "Gravel",   "speed_modifier": 1.5},
        'Mulch':    {"gait": "Mulch",    "speed_modifier": 2.0},
        'Dirt':     {"gait": "Dirt",     "speed_modifier": 1.75},
        'Sand':     {"gait": "Sand",     "speed_modifier": 2.5},  # Slowest
        'Unknown': {
            "gait": "Default", "notes": "Unknown surface, using default parameters."
        }
    }

    # --- Get Credentials from Secret Manager ---
    print("Fetching credentials from Secret Manager...")
    api_key = get_secret(project_id, "confluent-api-key")
    api_secret = get_secret(project_id, "confluent-api-secret")

    # --- Kafka Client Configuration ---
    kafka_config = {
    'bootstrap.servers': 'kafka:9092',
    'group.id': 'robot-dashboard-group',
    'auto.offset.reset': 'earliest'
}

    # --- Initialize Vertex AI ---
    print("Initializing Vertex AI...")
    aiplatform.init(project=project_id, location=vertex_ai_location)
    endpoint = aiplatform.Endpoint(endpoint_name=vertex_ai_endpoint_id)
    print(f"Vertex AI Endpoint '{endpoint.display_name}' ready.")

    # --- Initialize Kafka Clients ---
    admin_client = AdminClient(kafka_config)
    create_topic_if_not_exists(admin_client, outbound_topic) # Ensure the actions topic exists
    create_topic_if_not_exists(admin_client, raw_predictions_topic) # Ensure the raw predictions topic exists

    consumer = Consumer(kafka_config)
    producer = Producer(kafka_config)

    # --- State for Prediction Smoothing ---
    # We will now act on the first prediction of a new surface.
    confirmed_surface = None

    # --- Kafka Producer Callback ---
    def delivery_report(err, msg):
        """Callback for producer, reports delivery status."""
        if err is not None:
            print(f"  -> Failed to deliver action command: {err}")

    try:
        consumer.subscribe([inbound_topic])
        print(f"\nSubscribed to topic '{inbound_topic}'. Waiting for messages...")

        while True:
            # 1. Consume a message from the sensor topic
            msg = consumer.poll(1.0)  # Poll for messages with a 1-second timeout
            if msg is None:
                continue
            if msg.error():
                if msg.error().code() == KafkaError._PARTITION_EOF:
                    # End of partition event - not an error, just no more messages for now
                    print(f"%% {msg.topic()} [{msg.partition()}] reached end offset {msg.offset()}")
                elif msg.error():
                    raise KafkaException(msg.error())
            else:
                # Message received successfully
                key = msg.key().decode('utf-8') if msg.key() else 'None'
                payload_str = msg.value().decode('utf-8')
                try:
                    payload = json.loads(payload_str)
                    vibration_data_str = payload['vibration_data']
                    start_time = payload.get('start_time') # Safely get start_time
                except (json.JSONDecodeError, KeyError):
                    print(f"  -> Warning: Could not parse JSON payload or find keys. Treating as raw data.")
                    vibration_data_str = payload_str
                    start_time = None

                # 2. Parse and prepare data for the model
                values = vibration_data_str.split(',')
                if len(values) != len(feature_names):
                    print(f"  -> Error: Expected {len(feature_names)} features, but got {len(values)}. Skipping.")
                    continue
                instance_dict = dict(zip(feature_names, values))

                prediction = endpoint.predict(instances=[instance_dict])
                prediction_result = prediction.predictions[0]

                # 4. Process the prediction result
                scores = prediction_result['scores']
                classes = prediction_result['classes']
                max_score_index = scores.index(max(scores))
                predicted_class_id = classes[max_score_index]
                confidence = scores[max_score_index]

                surface_name = surface_map.get(predicted_class_id, "Unknown Surface")
                surface_color = colors.get(surface_name, colors['ENDC'])

                # Immediately send the raw, unsmoothed prediction to the dashboard
                raw_prediction_payload = {
                    'gait': surface_name,
                    'confidence': confidence,
                    'start_time': start_time
                }
                producer.produce(
                    raw_predictions_topic,
                    key=key,
                    value=json.dumps(raw_prediction_payload),
                    callback=delivery_report
                )

                # 5. Process prediction with smoothing logic
                # If the prediction is for a new surface, send a command.
                if surface_name != confirmed_surface:
                    print(f"Prediction: {surface_color}{surface_name}{colors['ENDC']} (Confidence: {confidence:.2%}) - New surface detected, sending action.")
                    
                    # Update the confirmed surface state
                    confirmed_surface = surface_name

                    # Get the command for the newly confirmed surface
                    command = action_commands.get(surface_name, action_commands['Unknown']).copy()

                    # Add the dynamic prediction data to the command
                    command['confidence'] = confidence
                    command['start_time'] = start_time  # Pass the timestamp through

                    # Send the command to the robot dashboard
                    producer.produce(
                        outbound_topic,
                        key=key,  # Use the same key to keep data for a surface in the same partition
                        value=json.dumps(command),  # Send the command dictionary as a JSON string
                        callback=delivery_report
                    )
                    producer.poll(0)  # Trigger delivery report to be called
                else:
                    # The prediction matches the current confirmed surface, so we do nothing.
                    print(f"Prediction: {surface_color}{surface_name}{colors['ENDC']} (Confidence: {confidence:.2%}) - Surface is stable.")

    except KeyboardInterrupt:
        pass
    finally:
        # Close down consumer to commit final offsets.
        consumer.close()
        print("Consumer closed.")

if __name__ == "__main__":
    main()
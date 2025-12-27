Robot Terrain Classification Dashboard
This project is a real-time data pipeline and dashboard for visualizing robot terrain classification data. It simulates a robot walking on different surfaces (Grass, Concrete, Gravel) by streaming force data through Apache Kafka (Confluent) to a web dashboard.

🏗 Architecture
The system is built using a microservices architecture containerized with Docker:

Producer (producer.py): Acts as the robot. It reads historical vibration data from a CSV and streams it to a Kafka topic (my-topic) when triggered via the web UI. It hosts the Flask Web Server on Port 5000.

Consumer (consumer.py): Acts as the AI/Processing unit. It listens for "robot actions" or predictions and broadcasts them back to the frontend via WebSockets.

Message Broker (Kafka & Zookeeper): Handles the asynchronous communication between the robot (Producer) and the dashboard (Consumer).

📊 Data Source Citation
This project utilizes the QCAT Legged Robot Terrain Classification Dataset.

Ahmadi, Reza; Nygaard, Tønnes; Kottege, Navinda; Howard, David; & Hudson, Nicolas (2020): QCAT legged robot terrain classification dataset. v2. CSIRO. Data Collection.

DOI: https://doi.org/10.25919/5f88b9c730442

🚀 Getting Started
Prerequisites
Docker Desktop (or Docker Engine + Compose) installed.

Google Cloud Service Account Key (JSON file) for Secret Manager access.

Installation
Clone the repository:
 - bash
        git clone <your-repo-url>
        cd AI_Partner

Add Credentials: Place your Google Cloud Service Account key in the root directory and name it gcp-key.json.

Note: This file is ignored by git to protect your secrets.

Launch the System: Run the entire stack with one command:
 - bash
        docker compose up --build

Access the Dashboard: Open your browser and navigate to:
http://localhost:5000

📂 Project Structure
AI_Partner/
├── Web Dashboard/          # HTML/CSS/JS frontend files
├── producer.py             # Flask Server + Kafka Producer
├── consumer.py             # Background Kafka Consumer
├── docker-compose.yml      # Docker services configuration
├── Dockerfile              # Python environment definition
├── requirements.txt        # Python dependencies
├── gcp-key.json            # (DO NOT COMMIT) Google Cloud credentials
└── AI_Partner_...csv       # QCAT Dataset Source File

🛠 Tech Stack
Language: Python 3.9

Web Framework: Flask & Flask-SocketIO

Messaging: Apache Kafka (Confluent)

Containerization: Docker & Docker Compose

Cloud Services: Google Cloud Secret Manager\Google Cloud

📝 License
This project is for educational/hackathon purposes. The dataset is licensed by CSIRO as cited above.

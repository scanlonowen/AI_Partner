# 1. Use a lightweight Python base image
FROM python:3.10-slim

# 2. Set the working directory inside the container to /app
#    (All your files will be copied here)
WORKDIR /app

# 3. Copy just the requirements file first (for efficient caching)
COPY requirements.txt .

# 4. Install dependencies
#    (This installs Flask, Kafka libraries, etc.)
RUN pip install --no-cache-dir -r requirements.txt

# 5. Copy the rest of your source code (producer.py, consumer.py) into the container
COPY . .

# Note: We do NOT set a specific CMD here because 
# docker-compose.yml handles running the specific scripts.
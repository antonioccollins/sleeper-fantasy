FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py engine.py sync.py ./
COPY static ./static
ENV DATA_DIR=/var/data PORT=8000
RUN mkdir -p /var/data
EXPOSE 8000
CMD ["sh", "-c", "python sync.py && exec gunicorn --bind 0.0.0.0:$PORT --workers 1 --threads 8 --timeout 90 app:application"]

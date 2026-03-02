FROM golang:1.25-bookworm

RUN apt-get update && apt-get install -y openssh-server curl \
    && mkdir /var/run/sshd \
    && rm -rf /var/lib/apt/lists/*

# Configure SSH
RUN echo "PermitRootLogin yes" >> /etc/ssh/sshd_config
RUN echo "PasswordAuthentication no" >> /etc/ssh/sshd_config
RUN echo "PubkeyAuthentication yes" >> /etc/ssh/sshd_config

# Expose Go and SSH ports
EXPOSE 8080 22

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN go build -o loop-server .

# Setup authorized keys
RUN mkdir -p /root/.ssh && chmod 700 /root/.ssh

# Startup script to run both sshd and our go server
RUN echo '#!/bin/bash\n/usr/sbin/sshd -D &\nLOOP_PORT=:8080 LOOP_DB_PATH=/app/loop.db ./loop-server' > /start.sh && chmod +x /start.sh

CMD ["/start.sh"]

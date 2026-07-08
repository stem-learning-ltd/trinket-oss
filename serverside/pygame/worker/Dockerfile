# Pygame Worker Container
# Provides a full graphical environment for pygame code execution

FROM ubuntu:22.04

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y \
    # Python
    python3 \
    python3-pip \
    python3-dev \
    python3-tk \
    # X11/VNC
    tightvncserver \
    xvfb \
    x11-xserver-utils \
    x11-apps \
    # noVNC and websockify
    novnc \
    websockify \
    # Audio (PulseAudio with virtual device)
    pulseaudio \
    pulseaudio-utils \
    # Process management
    supervisor \
    # Fonts (for pygame/matplotlib)
    fonts-dejavu-core \
    fonts-liberation \
    fontconfig \
    # Build tools for some Python packages
    build-essential \
    pkg-config \
    # Node.js
    curl \
    && curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs \
    # Cleanup
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install Python packages
COPY requirements.txt /tmp/requirements.txt
RUN pip3 install --no-cache-dir -r /tmp/requirements.txt

# Create non-root user for running code
RUN useradd -m -s /bin/bash trinket \
    && mkdir -p /home/trinket/.vnc /tmp/pygame \
    && chown -R trinket:trinket /home/trinket /tmp/pygame

# Set VNC password (empty for no password, or set a simple one)
RUN echo "" | vncpasswd -f > /home/trinket/.vnc/passwd \
    && chmod 600 /home/trinket/.vnc/passwd \
    && chown trinket:trinket /home/trinket/.vnc/passwd

# Copy the static supervisor program (shell.conf); the per-display xvnc/novnc
# programs are generated at container start by entrypoint.sh.
COPY supervisor/ /etc/supervisor/conf.d/
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Create app directory
WORKDIR /app

# Copy Node.js application
COPY trinket/ /app/
RUN npm install

# Copy config
COPY config/ /app/config/

# Environment variables
ENV DISPLAY=:1
ENV NODE_CONFIG_DIR=/app/config

# Expose ports
# 8010        - shell socket.io (flycast; wakes the worker)
# 5901..590N  - VNC servers (internal)
# 6081..608N  - noVNC WebSocket per display (reached via .internal from exec)
EXPOSE 8010

# Generate per-display supervisor programs (PYGAME_DISPLAYS), then run supervisord.
CMD ["/usr/local/bin/entrypoint.sh"]

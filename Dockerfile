FROM archlinux:latest

# Update system and install base dependencies
RUN pacman -Syu --noconfirm && \
    pacman -S --noconfirm \
    base-devel \
    curl \
    wget \
    git \
    file \
    openssl \
    gtk3 \
    libayatana-appindicator \
    librsvg \
    webkit2gtk \
    mingw-w64-gcc \
    mingw-w64-binutils \
    mingw-w64-crt \
    mingw-w64-headers \
    mingw-w64-winpthreads \
    python \
    python-pip \
    python-virtualenv \
    sudo \
    fakeroot \
    scons

# Create a non-root user for building AUR packages
RUN useradd -m -G wheel -s /bin/bash builder && \
    echo "builder ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers

# Install mingw-w64-zlib from AUR first (dependency for NSIS)
USER builder
WORKDIR /home/builder
RUN git clone https://aur.archlinux.org/mingw-w64-zlib.git && \
    cd mingw-w64-zlib && \
    makepkg -si --noconfirm --skippgpcheck

# Install NSIS from AUR
RUN git clone https://aur.archlinux.org/nsis.git && \
    cd nsis && \
    makepkg -si --noconfirm --skippgpcheck

USER root
WORKDIR /

# Note: NSIS is skipped as it has complex dependencies in Arch
# The .exe will still build, but the installer (.msi) won't be created
# If you need the installer, you can create it on a Windows machine later

# Install Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Add Windows target for Rust
RUN rustup target add x86_64-pc-windows-gnu

# Install Node.js and npm
RUN pacman -S --noconfirm nodejs npm

# Set up working directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install node dependencies
RUN npm install

# Copy the entire project
COPY . .

# Set up Python virtual environment
WORKDIR /app/src-tauri/python
# Remove any existing venv from the host machine
RUN rm -rf venv
RUN python -m venv venv && \
    source venv/bin/activate && \
    pip install --upgrade pip && \
    if [ -f requirements.txt ]; then pip install -r requirements.txt; fi

# Return to project root
WORKDIR /app

# Configure cargo for Windows cross-compilation
RUN mkdir -p ~/.cargo && \
    echo '[target.x86_64-pc-windows-gnu]' > ~/.cargo/config.toml && \
    echo 'linker = "x86_64-w64-mingw32-gcc"' >> ~/.cargo/config.toml && \
    echo 'ar = "x86_64-w64-mingw32-ar"' >> ~/.cargo/config.toml

# Build the Tauri app for Windows
ENV TAURI_SKIP_DEVSERVER_CHECK=true
RUN npm run tauri build -- --target x86_64-pc-windows-gnu

# The built .exe will be in src-tauri/target/x86_64-pc-windows-gnu/release/
CMD ["bash"]

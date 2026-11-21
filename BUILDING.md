# Building Photoboggan from Source

This guide explains how to build Photoboggan from source.

## 1. Common prerequisites

All platforms require:

- Node.js and npm

- Rust and Cargo

See the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for additional requirements.

## 2. Platforms

### Arch Linux

Install the required packages:

```
sudo pacman -S --needed \
base-devel \
git \
nodejs \
npm \
rust \
cargo \
webkit2gtk-4.1 \
gtk3 \
libappindicator-gtk3 \
librsvg \
patchelf \
perl 
```

### Debian / Ubuntu

```
sudo apt update
sudo apt install -y \
  build-essential \
  curl \
  wget \
  file \
  libssl-dev \
  libgtk-3-dev \
  libwebkit2gtk-4.1-dev \
  libappindicator3-dev \
  librsvg2-dev \
  gstreamer1.0-plugins-base \
  gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad \
  gstreamer1.0-plugins-ugly \
  gstreamer1.0-libav
```

## 3. Clone and install

```
git clone https://github.com/alexh3o/photoboggan.git
cd photoboggan
npm install
```

## 4. Build

To compile without generating an installation package:

```
npm run tauri build -- --no-bundle
```

The executable is generated in:

- **Linux:** `src-tauri/target/release/photoboggan`

- **Windows:** `src-tauri/target/release/photoboggan.exe`

- **macOS:** `src-tauri/target/release/photoboggan`

## Contributing

These instructions are community-maintained and may not cover every platform or Linux distribution yet.

If you successfully build Photoboggan on another platform or distribution, contributions are welcome! Feel free to open an issue with the steps you used, or submit a pull request to add them to this guide.

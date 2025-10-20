#!/bin/bash

set -e

SSL_DIR="nginx/ssl"
CERTBOT_DIR="nginx/certbot"
DOMAIN="${1:-}"
EMAIL="${2:-}"



print_error() { echo -e "${RED}ERROR: $1${NC}"; }
print_success() { echo -e "${GREEN}✓ $1${NC}"; }
print_info() { echo -e "${YELLOW}ℹ $1${NC}"; }

if [ -z "$DOMAIN" ] || [ -z "$EMAIL" ]; then
  print_error "Usage: ./generate-ssl.sh <domain> <email>"
  echo ""
  echo "Example: ./generate-ssl.sh example.com admin@example.email"
  echo ""
  print_info "For development/testing with self-signed certificates, run:"
  echo " ./generate-ssl.sh --dev"
  exit 1
fi

if [ "$DOMAIN" == "--dev" ]; then
  print_info "Generating self-signed SSL certificates for DEVELOPMENT..."


  mkdir -p "$SSL_DIR"


  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout "$SSL_DIR/key.pem" \
    -out "$SSL_DIR/cert.pem" \
    -subj "/C=US/ST=New Hampsire/L=Nashua/O=ApolloSFS/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,DNS:*.localhost,IP:192.168.68.54" 

  # change me to actual ip address

  chmod 600 "$SSL_DIR/key.pem"
  chmod 644 "$SSL_DIR/cert.pem"

  print_success "Self-signed certificates generate!"
  print_info "Certificate: $SSL_DIR/cert.pem"
  print_info "Private Key: $SSL_DIR/key.pem"

  exit 0
fi

mkdir -p "$SSL_DIR"
mkdir -p "$CERTBOT_DIR/www"
mkdir -p "$CERTBOT_DIR/conf"

print_info "Setting up Let's Encrypt certificates for $DOMAIN"
echo ""

if ! docker info > /dev/null 2>&1; then
  print_error "Docker is not running. Please start Docker first."
  exit 1
fi

if ! docker-compose ps nginx | grep -q "Up"; then
  print_error "Nginx container is not running."
  exit 1
fi

print_info "Obtaining SSL certificate from Let's Encrypt..."
echo ""

docker run --rm \
  -v "$(pwd)/$CERTBOT_DIR/conf:/etc/letsencrypt" \
  -v "$(pwd)/$CERTBOT_DIR/www:/var/www/certbot" \
  certbot/certbot certonly \
  --webroot \
  --webroot-path=/var/www/certbot \
  --email "$EMAIL" \
  --agree-tos \
  --no-eff-email \
  --force-renewal \
  -d "$DOMAIN"

if [ $? -eq 0 ]; then
  print_success "Certificates obtained successfully!"

  print_info "Copying certificates to nginx directory..."

  cp "$CERTBOT_DIR/conf/live/$DOMAIN/fullchain.pem" "$SSL_DIR/cert.pem"
  cp "$CERTBOT_DIR/conf/live/$DOMAIN/privkey.pem" "$SSL_DIR/key.pem"

  chmod 644 "$SSL_DIR/cert.pem"
  chmod 600 "$SSL_DIR/key.pem"

  print_success "Certificates installed"

  print_info "Certificate: $SSL_DIR/cert.pem"
  print_info "Private Key: $SSL_DIR/key.pem"
  echo ""

  print_info "Reloading nginx..."

  docker-compose exec nginx nginx -s reload
  exit 0
fi

print_error "Failed to obtain certificate from Let's Encrypt"
exit 1




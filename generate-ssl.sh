#!/bin/bash

# Script to set up SSL certificates from Cloudflare Origin Certificates
# This replaces the Let's Encrypt setup when using Cloudflare proxy

set -e

SSL_DIR="nginx/ssl"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

print_error() { echo -e "${RED}ERROR: $1${NC}"; }
print_success() { echo -e "${GREEN}✓ $1${NC}"; }
print_info() { echo -e "${YELLOW}ℹ $1${NC}"; }
print_step() { echo -e "${BLUE}➜ $1${NC}"; }

echo ""
print_step "Cloudflare Origin Certificate Setup"
echo ""

# Create SSL directory
mkdir -p "$SSL_DIR"

print_info "Follow these steps to get your Cloudflare Origin Certificate:"
echo ""
echo "1. Log into Cloudflare Dashboard: https://dash.cloudflare.com"
echo "2. Select your domain"
echo "3. Go to: SSL/TLS → Origin Server"
echo "4. Click: 'Create Certificate'"
echo "5. Configure:"
echo "   - Private key type: RSA (2048)"
echo "   - Hostnames: yourdomain.com, *.yourdomain.com"
echo "   - Certificate Validity: 15 years"
echo "6. Click: 'Create'"
echo ""

print_info "You will see two text boxes:"
echo "   - Origin Certificate (this is your cert.pem)"
echo "   - Private Key (this is your key.pem)"
echo ""

# Get certificate
print_step "Step 1: Enter your Origin Certificate"
echo "Paste the entire certificate (including BEGIN/END lines) and press Ctrl+D when done:"
echo ""

cat > "$SSL_DIR/cert.pem"

if [ ! -s "$SSL_DIR/cert.pem" ]; then
    print_error "Certificate file is empty"
    rm -f "$SSL_DIR/cert.pem"
    exit 1
fi

print_success "Certificate saved!"
echo ""

# Get private key
print_step "Step 2: Enter your Private Key"
echo "Paste the entire private key (including BEGIN/END lines) and press Ctrl+D when done:"
echo ""

cat > "$SSL_DIR/key.pem"

if [ ! -s "$SSL_DIR/key.pem" ]; then
    print_error "Private key file is empty"
    rm -f "$SSL_DIR/key.pem"
    exit 1
fi

print_success "Private key saved!"
echo ""

# Set proper permissions
chmod 644 "$SSL_DIR/cert.pem"
chmod 600 "$SSL_DIR/key.pem"

print_success "Permissions set correctly!"
echo ""

# Validate certificate
print_step "Validating certificate..."

if openssl x509 -in "$SSL_DIR/cert.pem" -noout -text > /dev/null 2>&1; then
    print_success "Certificate is valid!"
    
    # Show certificate details
    echo ""
    print_info "Certificate Details:"
    echo "-------------------"
    openssl x509 -in "$SSL_DIR/cert.pem" -noout -subject -issuer -dates
    echo ""
else
    print_error "Certificate validation failed!"
    print_info "Please make sure you copied the entire certificate correctly"
    exit 1
fi

# Validate private key
print_step "Validating private key..."

if openssl rsa -in "$SSL_DIR/key.pem" -check -noout > /dev/null 2>&1; then
    print_success "Private key is valid!"
else
    print_error "Private key validation failed!"
    print_info "Please make sure you copied the entire private key correctly"
    exit 1
fi

echo ""
print_success "✓ SSL certificates installed successfully!"
echo ""
print_info "Next steps:"
echo "  1. Ensure Cloudflare SSL/TLS mode is set to 'Full (strict)'"
echo "  2. Start your services: docker-compose up -d"
echo "  3. Your site will be available at: https://yourdomain.com"
echo ""
print_info "Note: These certificates are valid for 15 years and don't need renewal!"
echo ""
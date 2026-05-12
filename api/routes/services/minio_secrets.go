package services

// EncryptMinIOSecret encrypts a plain-text MinIO credential (access key or
// secret key) using AES-256-GCM with the provided KEK. Returns the ciphertext
// and a fresh random nonce; both must be persisted and provided to Decrypt.
func EncryptMinIOSecret(kek []byte, plaintext string) (enc, nonce []byte, err error) {
	return aesGCMEncrypt(kek, []byte(plaintext))
}

// DecryptMinIOSecret reverses EncryptMinIOSecret.
func DecryptMinIOSecret(kek []byte, enc, nonce []byte) (string, error) {
	plain, err := aesGCMDecrypt(kek, nonce, enc)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

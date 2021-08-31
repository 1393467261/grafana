package encryption

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"

	"github.com/grafana/grafana/pkg/util"
	"golang.org/x/crypto/pbkdf2"
)

const saltLength = 8

type EncryptionServiceImpl interface {
	Encrypt(payload, secret []byte) ([]byte, error)
	Decrypt(payload, secret []byte) ([]byte, error)
}

type OSSEncryptionService struct{}

func ProvideOSSEncryptionService() OSSEncryptionService {
	return OSSEncryptionService{}
}

func (s OSSEncryptionService) Encrypt(payload, secret []byte) ([]byte, error) {
	return encrypt(payload, secret)
}

func (s OSSEncryptionService) Decrypt(payload, secret []byte) ([]byte, error) {
	return decrypt(payload, secret)
}

// Decrypt decrypts a payload with a given secret.
func decrypt(payload, secret []byte) ([]byte, error) {
	if len(payload) < saltLength {
		return nil, fmt.Errorf("unable to compute salt")
	}
	salt := payload[:saltLength]
	key, err := encryptionKeyToBytes(secret, salt)
	if err != nil {
		return nil, err
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}

	// The IV needs to be unique, but not secure. Therefore it's common to
	// include it at the beginning of the ciphertext.
	if len(payload) < aes.BlockSize {
		return nil, errors.New("payload too short")
	}
	iv := payload[saltLength : saltLength+aes.BlockSize]
	payload = payload[saltLength+aes.BlockSize:]
	payloadDst := make([]byte, len(payload))

	stream := cipher.NewCFBDecrypter(block, iv)

	// XORKeyStream can work in-place if the two arguments are the same.
	stream.XORKeyStream(payloadDst, payload)
	return payloadDst, nil
}

// Encrypt encrypts a payload with a given secret.
func encrypt(payload, secret []byte) ([]byte, error) {
	salt, err := util.GetRandomString(saltLength)
	if err != nil {
		return nil, err
	}

	key, err := encryptionKeyToBytes(secret, []byte(salt))
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}

	// The IV needs to be unique, but not secure. Therefore it's common to
	// include it at the beginning of the ciphertext.
	ciphertext := make([]byte, saltLength+aes.BlockSize+len(payload))
	copy(ciphertext[:saltLength], salt)
	iv := ciphertext[saltLength : saltLength+aes.BlockSize]
	if _, err := io.ReadFull(rand.Reader, iv); err != nil {
		return nil, err
	}

	stream := cipher.NewCFBEncrypter(block, iv)
	stream.XORKeyStream(ciphertext[saltLength+aes.BlockSize:], payload)

	return ciphertext, nil
}

// Key needs to be 32bytes
func encryptionKeyToBytes(secret, salt []byte) ([]byte, error) {
	return pbkdf2.Key(secret, salt, 10000, 32, sha256.New), nil
}

"""
Encryption utilities for LLM API keys.

Uses Fernet (symmetric) with a master key stored in teahouse.yaml.
"""
from cryptography.fernet import Fernet


def generate_master_key() -> str:
    """Generate a new Fernet key (base64-encoded 32 bytes)."""
    return Fernet.generate_key().decode("utf-8")


def encrypt_value(plaintext: str, master_key: str) -> str:
    f = Fernet(master_key.encode("utf-8"))
    return f.encrypt(plaintext.encode("utf-8")).decode("utf-8")


def decrypt_value(ciphertext: str, master_key: str) -> str:
    f = Fernet(master_key.encode("utf-8"))
    return f.decrypt(ciphertext.encode("utf-8")).decode("utf-8")

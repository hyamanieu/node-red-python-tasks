# Test module for Node-RED Python nodes

def multiply(a, b):
    """Multiply two numbers."""
    return a * b

def add(a, b):
    """Add two numbers."""
    return a + b

def process_payload(payload):
    """Process a payload."""
    if isinstance(payload, dict):
        return {k: v * 2 for k, v in payload.items()}
    return payload * 2

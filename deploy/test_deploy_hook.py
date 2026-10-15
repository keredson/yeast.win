import hashlib
import hmac
import unittest

from deploy_hook import valid_signature


class SignatureTests(unittest.TestCase):
    def test_valid_signature(self):
        body = b'{"commit":"abc"}'
        digest = hmac.new(b"secret", b"1000." + body, hashlib.sha256).hexdigest()
        self.assertTrue(valid_signature("secret", "1000", body, f"sha256={digest}", now=1000))

    def test_rejects_stale_and_changed_requests(self):
        body = b"{}"
        digest = hmac.new(b"secret", b"1000." + body, hashlib.sha256).hexdigest()
        self.assertFalse(valid_signature("secret", "1000", body, f"sha256={digest}", now=1301))
        self.assertFalse(valid_signature("secret", "1000", b'{"changed":true}', f"sha256={digest}", now=1000))


if __name__ == "__main__":
    unittest.main()

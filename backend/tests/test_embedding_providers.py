import unittest

from app.embedding_providers import Jina9RouterProvider, ProviderError, get_provider


class GetProviderTests(unittest.TestCase):
    def test_returns_the_registered_adapter(self):
        provider = get_provider("jina_9router")
        self.assertIsInstance(provider, Jina9RouterProvider)

    def test_unknown_provider_raises_with_the_known_list(self):
        with self.assertRaisesRegex(ProviderError, "jina_9router"):
            get_provider("some_other_gateway")


class Jina9RouterProviderTests(unittest.TestCase):
    """Regression for the 2026-08-25 outage: these shapes are the ones a live
    call against api.example.com actually returned HTTP 200 for -- see
    app.embedding_providers.Jina9RouterProvider's docstring.
    """

    def setUp(self):
        self.provider = Jina9RouterProvider()

    def test_bytes_request_puts_the_base64_string_under_image(self):
        body = self.provider.build_bytes_request(model="jina-ai/jina-clip-v2", dimensions=512, encoded_base64="Zm9v")
        self.assertEqual(body["input"], [{"image": "Zm9v"}])
        self.assertEqual(body["model"], "jina-ai/jina-clip-v2")
        self.assertEqual(body["dimensions"], 512)

    def test_url_request_puts_the_url_under_image_not_url(self):
        body = self.provider.build_url_request(
            model="jina-ai/jina-clip-v2", dimensions=512, image_url="https://example.test/x.jpg"
        )
        self.assertEqual(body["input"], [{"image": "https://example.test/x.jpg"}])
        self.assertNotIn("url", body["input"][0])
        self.assertNotIn("bytes", body["input"][0])

    def test_extract_vector_reads_data_zero_embedding(self):
        vector = self.provider.extract_vector({"data": [{"embedding": [0.1, 0.2]}]})
        self.assertEqual(vector, [0.1, 0.2])

    def test_extract_vector_raises_provider_error_on_malformed_response(self):
        with self.assertRaises(ProviderError):
            self.provider.extract_vector({"unexpected": "shape"})


if __name__ == "__main__":
    unittest.main()

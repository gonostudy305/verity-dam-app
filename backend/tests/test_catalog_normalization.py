from app.catalog_normalization import catalog_brand, classify_catalog_sku, infer_catalog_brand, normalize_catalog_sku


def test_classifies_human_model_name_without_rewriting_source_value():
    value = normalize_catalog_sku(" Deebot T30C Prime Omni ")

    assert value == "Deebot T30C Prime Omni"
    assert classify_catalog_sku(value) == "model_name"


def test_classifies_machine_sku():
    assert classify_catalog_sku("IPC-A42P-D") == "machine_code"


def test_infers_brand_from_product_title_only():
    assert infer_catalog_brand("Robot hút bụi lau nhà Ecolo Deebot T30C Prime Omni") == "Ecolo"
    assert infer_catalog_brand("Máy hút bụi lau nhà Rover F25 Steam") == "Rover"


def test_explicit_woocommerce_brand_wins_over_ecosystem_mentions():
    assert catalog_brand(
        {
            "name": "Khoá cửa kính AZT-18 Pro Tích hợp Vân Tay Face ID app Tera",
            "brands": [{"name": "Verity"}],
        }
    ) == "Verity"
    assert catalog_brand(
        {
            "name": "Camera giám sát TP-Link Tabo C125 (Homekit)",
            "attributes": [{"slug": "pa_brands", "options": ["Tabo"]}],
        }
    ) == "Tabo"
    assert catalog_brand(
        {"name": "Khóa Vân Tay Verity Nova D1 Pro", "brands": [{"name": "Verity"}]}
    ) == "Verity"


def test_catalog_brand_canonicalizes_common_woocommerce_casing_variants():
    assert catalog_brand({"brands": [{"name": "PHILIPS"}]}) == "Philips"
    assert catalog_brand({"brands": [{"name": "D_Link"}]}) == "D-Link"
    assert catalog_brand({"brands": [{"name": "UVGREEN"}]}) == "UVGreen"


def test_does_not_infer_brand_from_unbounded_text():
    assert infer_catalog_brand("Sản phẩm hỗ trợ Apple HomeKit") is None
    assert infer_catalog_brand("Thiết bị thông minh không ghi thương hiệu") is None

from src.defaults import ROOM_DEFAULTS, resolve_footprint


def test_bathroom_matches_brief_minimum():
    default = ROOM_DEFAULTS["bathroom"]
    assert default.min_width_m == 1.5
    assert default.min_depth_m == 1.75


def test_explicit_size_wins_over_default():
    footprint = resolve_footprint("bedroom", explicit_width_m=5.0, explicit_depth_m=5.0)
    assert footprint.width_m == 5.0
    assert footprint.depth_m == 5.0


def test_missing_size_falls_back_to_typical():
    default = ROOM_DEFAULTS["kitchen"]
    footprint = resolve_footprint("kitchen", explicit_width_m=None, explicit_depth_m=None)
    assert footprint.width_m == default.typical_width_m
    assert footprint.depth_m == default.typical_depth_m


def test_unknown_room_type_falls_back_to_other():
    footprint = resolve_footprint("nonexistent_type", None, None)
    other = ROOM_DEFAULTS["other"]
    assert footprint.width_m == other.typical_width_m


def test_a_workspace_id_is_sent_as_a_header_when_one_is_configured():
    """An identity-linked key must name the workspace each request acts in;
    a plain key ignores the header, so it is set whenever configured."""
    import os

    from src.claude_client import get_client

    os.environ["ANTHROPIC_API_KEY"] = "sk-ant-test"
    os.environ["ANTHROPIC_WORKSPACE_ID"] = "wrkspc_123"
    get_client.cache_clear()
    try:
        assert get_client().default_headers["anthropic-workspace-id"] == "wrkspc_123"
        del os.environ["ANTHROPIC_WORKSPACE_ID"]
        get_client.cache_clear()
        assert "anthropic-workspace-id" not in get_client().default_headers
    finally:
        os.environ.pop("ANTHROPIC_WORKSPACE_ID", None)
        os.environ.pop("ANTHROPIC_API_KEY", None)
        get_client.cache_clear()

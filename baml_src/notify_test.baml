test "release names the entity, falls back through refs" {
    assert.equal(
        shape_notification("LeaseRelease", "bi#44", null, null, null, null, false, null, null),
        "peer released bi#44",
    );
    assert.equal(
        shape_notification("LeaseRelease", null, "hub:claim:3", null, null, null, false, null, null),
        "peer released hub:claim:3",
    );
    assert.equal(
        shape_notification("LeaseRelease", null, null, null, null, null, false, null, null),
        "peer released ?",
    );
}

test "heartbeat never shapes, expiry fires on type or body keys" {
    assert.is_true(
        shape_notification("Heartbeat", null, null, null, null, null, false, null, null) is null,
    );
    assert.equal(
        shape_notification("LeaseExpiring", "bi#45", null, null, null, null, false, "7", null),
        "lease on bi#45 expires in 7",
    );
    // Body-carried expiry with a non-expiry type still shapes.
    assert.equal(
        shape_notification("Renewed", null, "bi#45", null, null, null, true, "12", null),
        "lease on bi#45 expires in 12",
    );
}

test "oversight carries the reason, unknown types fall back" {
    assert.equal(
        shape_notification("OversightFlag", "bi#46", null, null, null, null, false, null, "conflict"),
        "oversight flagged bi#46 (conflict)",
    );
    assert.equal(
        shape_notification("Oversight", null, null, null, null, "bi#46", false, null, null),
        "oversight flagged bi#46",
    );
    assert.equal(
        shape_notification("SomethingNew", "bi#47", null, null, null, null, false, null, null),
        "hub SomethingNew on bi#47",
    );
    assert.equal(
        shape_notification("SomethingNew", null, null, null, null, null, false, null, null),
        "hub SomethingNew",
    );
}

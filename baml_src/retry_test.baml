testset "retry policy" {
    test "unsafe never retries" {
        assert.equal(should_retry("rate_limited", false, 0), false);
        assert.equal(should_retry("network", false, 0), false);
        assert.equal(should_retry("rate_limited", false, 2), false);
    }

    test "only rate_limited and network retry" {
        assert.equal(should_retry("rate_limited", true, 0), true);
        assert.equal(should_retry("network", true, 0), true);
        assert.equal(should_retry("invalid_request", true, 0), false);
        assert.equal(should_retry("refused", true, 0), false);
        assert.equal(should_retry("parse_failed", true, 0), false);
        assert.equal(should_retry("step_budget_exceeded", true, 0), false);
        assert.equal(should_retry("unknown", true, 0), false);
    }

    test "budget exhausts after max_retries" {
        assert.equal(should_retry("network", true, 0), true);
        assert.equal(should_retry("network", true, 1), true);
        assert.equal(should_retry("network", true, 2), true);
        assert.equal(should_retry("network", true, 3), false);
        assert.equal(should_retry("network", true, 99), false);
    }

    test "backoff doubles from base" {
        assert.equal(backoff_ms(0), 500);
        assert.equal(backoff_ms(1), 1000);
        assert.equal(backoff_ms(2), 2000);
    }

    test "backoff caps at max" {
        assert.equal(backoff_ms(5), 10000);
        assert.equal(backoff_ms(100), 10000);
    }
}

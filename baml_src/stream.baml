// bi#168: BAML-owned shaping for the incremental live-stream path.
//
// The host streams per-turn assistant text while the turn runs (kimi
// streaming-ui.ts: appendAssistantDelta accumulates, scheduleFlush
// throttles at STREAMING_UI_FLUSH_MS, finalize settles the transcript).
// This file owns the only shaping the live path needs: splitting a
// completed per-turn text into flush-sized pieces. The settled
// transcript still renders through the markdown shaper at completion,
// so pipes stay byte-identical single-shot.
//
// NOTE: slice() is byte-based — chunk_chars counts bytes, not glyphs.
// Live output is transient (stderr, discarded on abort), so a multibyte
// character may straddle a chunk edge mid-stream; the final render is
// unaffected. Tests pin ASCII behavior only.
function chunk_stream_text(text: string, chunk_chars: int) -> string[] {
    let parts: string[] = [];
    if (text.length() == 0) {
        return parts;
    }
    let size = if (chunk_chars <= 0) {
        text.length()
    } else {
        chunk_chars
    };
    let i = 0;
    while (i < text.length()) {
        let end = i + size;
        if (end > text.length()) {
            end = text.length();
        }
        parts.push(text.slice(i, end));
        i = end;
    }
    return parts;
}

testset "stream chunking (bi#168)" {
    test "empty text yields no chunks" {
        assert.equal(chunk_stream_text("", 4).length(), 0)
    }

    test "even split" {
        let parts = chunk_stream_text("abcdef", 2);
        assert.equal(parts.length(), 3);
        assert.equal(parts[0], "ab");
        assert.equal(parts[1], "cd");
        assert.equal(parts[2], "ef")
    }

    test "ragged tail" {
        let parts = chunk_stream_text("hello world", 4);
        assert.equal(parts.length(), 3);
        assert.equal(parts[0], "hell");
        assert.equal(parts[1], "o wo");
        assert.equal(parts[2], "rld")
    }

    test "chunks rejoin to the input" {
        let parts = chunk_stream_text("the quick brown fox", 5);
        let back = "";
        let i = 0;
        while (i < parts.length()) {
            back = back + parts[i];
            i = i + 1;
        }
        assert.equal(back, "the quick brown fox")
    }

    test "chunk wider than text yields one chunk" {
        let parts = chunk_stream_text("hi", 100);
        assert.equal(parts.length(), 1);
        assert.equal(parts[0], "hi")
    }

    test "non-positive size yields the whole text as one chunk" {
        let parts = chunk_stream_text("solo", 0);
        assert.equal(parts.length(), 1);
        assert.equal(parts[0], "solo")
    }
}

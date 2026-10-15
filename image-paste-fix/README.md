# Image Paste Fix

Makes Ctrl+V image paste actually attach the image bytes to the model.

## Why

Pi's `handleClipboardPaste` writes clipboard images to `os.tmpdir()/pi-clipboard-{uuid}.{ext}` and inserts only the file path into the editor. The interactive `session.prompt(text)` call only forwards text, so the model sees the path string but never the image bytes. CLI mode (`--image-path`) works because it routes through `initialImages`.

This extension closes that gap: at the `input` event (last point before the provider), it scans for the `pi-clipboard-…` filename, reads the file from `os.tmpdir()`, and attaches the bytes via the `transform` action.

## Behavior

- Detects `pi-clipboard-{uuid}.{png|jpg|jpeg|gif|webp}` anywhere in the input text
- Reads the file from `os.tmpdir()` and appends to `event.images`
- Preserves the original text (path stays visible to you and to other extensions like vision-guard)
- Skips silently if the temp file is gone (tmpdir rotation, OS reboot, paused-then-sent)
- Hard cap 10 MiB per image; larger files are skipped with a stderr warning
- Deduplicates by UUID (same paste won't attach twice)

## Off-switch

`vision-guard` continues to warn when a model without `"image"` in its input list receives a message with images. That's still correct: it now warns about a model config issue, not a paste bug.

If you need to disable this extension for any reason, comment out the line in `package.json#pi.extensions` and reload pi.

## Limitations

- Relies on pi's exact filename format `pi-clipboard-{uuid}.{ext}`. If pi changes this in a future version, the regex needs updating.
- The cap and lookup behavior assumes images are in `os.tmpdir()`. Pi always writes there today.
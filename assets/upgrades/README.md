# Upgrade artwork

Drop one image per Galaxy Life unit or building here. When someone runs
`/upgrade duration:4h name:S-Trike`, the bot attaches the matching image.

## Naming

**Name the file after the thing, that's all.** Matching ignores case,
separators and accents, so every one of these files works and is found by all
the spellings a player might type:

| File | Matches |
|---|---|
| `s-trike.png` | `S-Trike`, `s trike`, `strike`, `S.Trike`, `s_trike` |
| `Starport.PNG` | `starport`, `Star Port`, `STARPORT` |
| `compact-house.webp` | `Compact House`, `compacthouse` |

Accepted extensions: `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`.

Level suffixes are stripped: `Laboratory lvl 5`, `Laboratory 3` and
`Laboratory level 2` all find `laboratory.png`. A name that merely *contains* a
known one works too: `upgrading my starport tonight` finds `Starport.PNG`.

## Nicknames

For names the normalisation cannot guess, add an `aliases.json` next to the
images:

```json
{
  "labo": "laboratory",
  "sniper": "sniper-tower",
  "tc": "training-camp"
}
```

The key is what people type, the value is the image name (without extension).

## Notes

- No image for a name is not an error: the timer runs, the message just has no
  picture.
- Keep the files reasonably small — Discord shows attachments at native size.
- The library is indexed at startup. **Restart the bot after adding images.**

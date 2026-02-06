name: x-audio-brief
description: Search X for a topic and generate an audio brief script
args:
  topic:
    description: What to search for on X
    default: "OpenClaw"
  days:
    description: How many days back to search
    default: "7"
steps:
  # NOTE: This assumes 'search-x' skill is installed in the current directory.
  # Install with: clawhub install search-x
  - id: search
    command: node search-x/scripts/search.js --days ${days} "${topic}"

  - id: summarize
    prompt: |
      Write a 5-minute audio brief script about "${topic}" based on the
      X/Twitter posts below.

      Guidelines:
      - Conversational, podcast-style tone
      - Group by theme, not chronologically
      - Mention specific users/accounts when relevant
      - Open with a greeting and close with a sign-off
      - No markdown formatting — this will be read aloud by TTS
      - Target approximately 700 words
    stdin: $search.stdout
    system: You are a tech podcast host who creates engaging audio briefings.

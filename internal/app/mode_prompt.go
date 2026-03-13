package app

import "strings"

func buildAskPrompt(prompt string) string {
	prompt = strings.TrimSpace(prompt)
	return strings.TrimSpace(`You are operating in ask mode.

Answer the user's request directly.
Do not edit files.
Do not apply patches.
Do not run shell commands unless they are strictly required to answer, and prefer not to run them.
If implementation work is needed, explain what should be changed instead of changing it.

User request:
` + prompt)
}

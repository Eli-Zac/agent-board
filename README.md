# Agent Board

A Claude Code mod that opens a side panel called **Agent Board** in every session. Each subagent the
session starts gets its own card, and the cards split the panel's full height evenly. A card shows the
agent's status and task description, then a line with its model, tokens, tool count, elapsed time and type, followed by a live feed of
its work: each tool call with its full output underneath (errors in red), streamed text and thinking,
and its final answer.

![Agent Board panel: three subagent cards, each with a coloured model badge and token count under its title, showing tool calls with their output and an error in red, the first card in view with a Back button, the second scrolled back with a Latest button, and the Clear completed button](docs/panel.svg)

<sub>Illustration of the panel, not a live capture.</sub>

- `/agent-board` reopens the panel if you closed it.
- Scroll with the mouse wheel over a card to go back through that agent's whole history. While
  you're scrolled back, the card shows how many newer lines there are and a **Latest** button that
  returns to live output. A card keeps its last 300 entries (about 120,000 characters); a single
  tool output over 4,000 characters keeps its start and end.
- **View** on a card switches the main view to that agent's transcript, as picking it from the tasks
  list does. The card you're viewing gets a magenta border, and its button changes to **Back**, which
  returns to the main conversation.
- The **Clear completed** button at the top of the panel (or `c` while the panel has focus) removes
  finished, failed and stopped agents. It shows only while there are finished agents.
- `/agent-board clear` does the same from the prompt.

Running agents are listed first, then finished ones (newest first). When there are more agents than
fit at four rows each, the extras are counted on a footer line.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install agent-board --marketplace Eli-Zac/agent-board
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install agent-board --marketplace Eli-Zac/agent-board
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `Eli-Zac/agent-board`, then Add plugin.

## License

MIT, see [LICENSE](LICENSE).

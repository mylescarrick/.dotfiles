# pi-model-families

Pi package for role-based model defaults.

Pi's built-in defaults select one provider/model/thinking level. This package adds a small routing
layer where users choose a **family** and the extension selects concrete models by role:
`research`, `architecture`, `planning`, `delivery`, and `verification`.

## Install

During local dotfiles development this package is loaded from `~/.pi/packages/pi-model-families`.
When published, install it with:

```sh
pi install npm:pi-model-families
```

## Config

Global defaults live at:

```text
~/.pi/agent/model-families.json
```

Trusted projects can override them with:

```text
.pi/model-families.json
```

See `examples/model-families.json` for a complete example.

## Commands

```text
/model-family                 # status
/model-family list            # list configured families
/model-family use <family>    # set active family and resume auto-routing
/model-family default         # switch to config.defaultFamily
/model-family role <role>     # queue/apply a role for the next turn
/model-family <role> [prompt] # shorthand; optionally send prompt immediately
/model-family lock            # stop routing and keep current model
/model-family reload          # reload global + project JSON
/mf ...                       # alias
```

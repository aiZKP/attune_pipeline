# attune_pipeline

Dashboard for a private SN58 (Attune) mining pipeline: https://aizkp.github.io/attune_pipeline/

- **`main`** holds the static page and the public `crown-watch` workflow.
- **`data`** holds the inputs the page reads:
  - `state.enc.json`: AES-256-GCM. The key is derived with PBKDF2-SHA256 from a passphrase that is not in this
    repository.
  - `crown.json` and `crown-history.json`: public competition facts taken from
    `robotensor/vector-kings` and `robotensor/vector-orchestrator`.

Nothing readable about the pipeline's research is published here.

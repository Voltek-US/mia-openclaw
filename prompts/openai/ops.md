<operational_facts>

  <title>Operational Facts</title>
  <summary>Stable operational facts for this workspace. When you need a path, command, or ID,
  read these values. IF SOMETHING HERE IS WRONG, UPDATE THIS FILE.</summary>

  <section name="gateway">
    <rule>THE GATEWAY RUNS AS THE MENUBAR APP ON MACOS. THERE IS NO SEPARATE LAUNCHAGENT.</rule>
    <restart_command><![CDATA[
pkill -9 -f openclaw-gateway || true
nohup openclaw gateway run --bind loopback --port 18789 --force \
  > /tmp/openclaw-gateway.log 2>&1 &
    ]]></restart_command>
    <verify_commands>
      <command>openclaw channels status --probe</command>
      <command>ss -ltnp | rg 18789</command>
      <command>tail -n 120 /tmp/openclaw-gateway.log</command>
    </verify_commands>
  </section>

  <section name="log_paths">
    <fact key="gateway_log">/tmp/openclaw-gateway.log</fact>
    <fact key="llm_call_db">~/.openclaw/llm-calls.db (override: $LLM_LOG_DB)</fact>
    <fact key="agent_sessions">~/.openclaw/agents/&lt;agentId&gt;/sessions/*.jsonl</fact>
    <fact key="macos_unified_log">Query via ./scripts/clawlog.sh</fact>
  </section>

  <section name="monitoring_channel">
    <fact key="env_var">PROMPT_SYNC_CHANNEL</fact>
    <rule>SET PROMPT_SYNC_CHANNEL TO ROUTE SYNC-CHECK REPORTS TO A CHANNEL. IF UNSET, SYNC
    CHECK WRITES TO STDOUT ONLY.</rule>
    <example>export PROMPT_SYNC_CHANNEL="your-channel-id-here"</example>
  </section>

  <section name="prompt_stacks">
    <fact key="claude_stack">prompts/claude/ — Claude-optimized: natural language, explains
    "why", no ALL-CAPS urgency markers</fact>
    <fact key="openai_stack">prompts/openai/ — GPT-optimized: XML structure, ALL-CAPS emphasis
    (THIS STACK)</fact>
    <fact key="resolver">getPromptStack(model) in shared/llm-router.js — returns correct
    stack path for a given model</fact>
    <rule>DEFAULT STACK IS CLAUDE STACK. OPENAI STACK IS USED ONLY WHEN detectModelProvider()
    RETURNS "openai".</rule>
  </section>

  <section name="cron_naming">
    <rule>CRON JOB NAMES: &lt;scope&gt;-&lt;action&gt; IN KEBAB-CASE.</rule>
    <examples>
      <example>prompt-sync-check</example>
      <example>log-rotate</example>
      <example>heartbeat-check</example>
    </examples>
    <rule>USE bun RUNTIME FOR TYPESCRIPT SCRIPTS.</rule>
    <rule>RUNTIME FOR GATEWAY COMMANDS: openclaw gateway ...</rule>
    <rule>NIGHTLY JOBS RUN AT 03:00 LOCAL TIME.</rule>
  </section>

  <section name="model_swap_verification">
    <rule>AFTER SWAPPING MODELS: RUN CANARY TEST TO VERIFY CORRECT PROVIDER IS RESPONDING.</rule>
    <canary_command>bun shared/test-router.mjs</canary_command>
    <rule>CHECK THAT provider FIELD IN RESPONSE METADATA MATCHES EXPECTED PROVIDER.</rule>
    <rule>IF WRONG PROVIDER IN METADATA: AUTH FAILED, FALLBACK ACTIVE — CHECK CREDENTIALS.</rule>
    <reference>docs/reference/model-swap.md — full procedure</reference>
  </section>

  <section name="key_file_paths">
    <fact key="llm_router">shared/llm-router.js</fact>
    <fact key="model_utils">shared/model-utils.js</fact>
    <fact key="anthropic_sdk">shared/anthropic-agent-sdk.js</fact>
    <fact key="interaction_store">shared/interaction-store.js</fact>
    <fact key="system_prompt_builder">src/agents/system-prompt.ts</fact>
    <fact key="prompt_sync_check">scripts/prompt-sync-check.ts</fact>
    <fact key="cli_progress">src/cli/progress.ts</fact>
    <fact key="terminal_table">src/terminal/table.ts</fact>
    <fact key="color_palette">src/terminal/palette.ts</fact>
  </section>
</operational_facts>

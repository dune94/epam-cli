/**
 * A CODELINE WHOSE FOLDER NAME HAS DOTS STILL GETS ITS TOOL CALLS.
 *
 * Live 2026-10-01 (AMSD-2974, codemie-web, run 20261001T181327Z): the detectives for
 * next.upexpress.com, next.gotransit.com and next.metrolinx.com never ran a tool. CodeMie addresses a
 * tool request to a plugin as "<key>.<session>.<label>.<tool>", split on dots; the read-write plugin's
 * label was the codeline folder's name, so the dots in it broke the split and every request was
 * refused "Invalid label". cx-shared (no dots) worked. With no clock, the three detectives hung.
 *
 * EXECUTED: CodeMie's own NatsClient._handle_tool_request (the installed codemie package), on a client
 * labelled the way the plugin host labels it, with the subject CodeMie builds.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { builtPythonEnv } from '../../mock-agent/python-env';

const ROOT = join(__dirname, '../../..');
const PROVIDER = join(ROOT, 'orchestrations/plugins/providers/codemie-web');
const env = builtPythonEnv(ROOT, 'codemie-web');

/** The handler's verdict on a request addressed to a plugin labelled for `root`. */
function verdict(root: string): { label: string; error: string } {
  const py = `
import asyncio, sys, types
sys.path.insert(0, ${JSON.stringify(PROVIDER)})
from codemie.nats_client import NatsClient
from plugin_ro import plugin_label
label = plugin_label(${JSON.stringify(root)})
c = object.__new__(NatsClient)
c.session_id, c.plugin_key, c.label, c.tools = "sess", "key", label, {}
msg = types.SimpleNamespace(subject=f"key.sess.{label}.read_file", data=b"{}", reply="r")
try:
    asyncio.run(c._handle_tool_request(msg)); err = ""
except Exception as e:
    err = str(e)
print("LABEL=" + label); print("ERR=" + err)
`;
  const r = spawnSync(join(env!.env, 'bin/python'), ['-c', py], { encoding: 'utf8' });
  const pick = (k: string) => (r.stdout.split('\n').find((l) => l.startsWith(`${k}=`)) || '').slice(k.length + 1);
  expect(r.stdout, `the handler did not run: ${r.stderr.slice(-400)}`).toMatch(/^LABEL=/m);
  return { label: pick('LABEL'), error: pick('ERR') };
}

describe('a dotted codeline gets its tool calls', () => {
  it('the CodeMie client is present — otherwise nothing below means anything', () => {
    expect(env, 'the codemie-web set declares no python env').toBeTruthy();
  });

  for (const root of ['/x/codelines/next.upexpress.com', '/x/codelines/next.gotransit.com', '/x/codelines/cx-shared']) {
    it(`a tool request for a plugin rooted at ${root.split('/').pop()} is not refused for its label`, () => {
      const v = verdict(root);
      expect(v.label, 'no label was produced').toBeTruthy();
      expect(v.error).not.toMatch(/Invalid label|Invalid subject|Invalid session|Invalid plugin_key/);
    });
  }

  it('two codelines never share a label', () => {
    expect(verdict('/x/next.upexpress.com').label).not.toBe(verdict('/x/next.gotransit.com').label);
  });
});

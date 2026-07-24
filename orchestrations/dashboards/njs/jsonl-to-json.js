// Grafana's Infinity datasource does a single JSON.parse() on the whole
// response body — it has no native support for JSON-Lines (one JSON object
// per line), which is the format every *.jsonl pipeline log uses. That
// mismatch is why Pipeline Cost / Run Timeline showed "No data" (a real
// parse error, not empty data) — found 2026-07-23.
//
// This handler reads the requested .jsonl file directly off disk (mounted
// at /logs-dir, same volume nginx's own /logs/ location uses) and returns
// it wrapped as a proper JSON array, so Infinity's parser succeeds.
import fs from 'fs';

function toJson(r) {
  var filename = r.uri.replace(/^\/logs-json\//, '');
  if (filename.indexOf('..') !== -1 || filename.indexOf('/') !== -1) {
    r.return(400, '[]');
    return;
  }

  var body;
  try {
    body = fs.readFileSync('/logs-dir/' + filename, 'utf8');
  } catch (e) {
    r.return(404, '[]');
    return;
  }

  var lines = body.split('\n').filter(function (line) {
    return line.trim().length > 0;
  });

  r.headersOut['Content-Type'] = 'application/json';
  r.headersOut['Cache-Control'] = 'no-store, no-cache, must-revalidate';
  r.return(200, '[' + lines.join(',') + ']');
}

export default { toJson };

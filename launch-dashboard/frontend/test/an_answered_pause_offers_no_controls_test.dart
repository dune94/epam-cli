// A ROW WHOSE QUESTION HAS BEEN ANSWERED OFFERS NO CONTROLS.
//
// Live 2026-09-04, pipeline-tests-19, verbatim from the operator:
//
//   "But now the screen is showing a second row - is this expected - the first row still has a
//    resume button on it even though it is now in flight this was not thought through."
//
// Resuming creates a new row on purpose, so history records both the pause and the answer to it.
// The paused row now moves to `resumed` (terminal) instead of staying `paused` forever. This file
// pins what that means for the CONTROLS the row draws, because the backend change alone is not
// the fix: the frontend derives every button from the status string, and `isFinished` is defined
// as "not active and not paused" — which `resumed` satisfies, so the row would silently start
// offering REPLAY instead.
//
// Replay is not a harmless alternative here. A replay is a FRESH run, and a fresh run on a
// brownfield defect resets the codeline to baseline — the exact 2026-09-02 incident that cost
// committed work. An answered pause must offer neither: the resumed run is the live one and
// carries the controls.
import 'package:flutter_test/flutter_test.dart';
import 'package:epam_launch_dashboard/api.dart';

Run runWith(String status, {String? runId = 'run-abc'}) => Run.fromJson({
      'id': 'r1',
      'ticket': 'AMSD-1919',
      'requestedBy': 'op',
      'status': status,
      'runId': runId,
      'createdAt': '2026-09-04T00:00:00Z',
      'updatedAt': '2026-09-04T00:00:00Z',
    });

void main() {
  group('an answered pause', () {
    test('offers no resume — the decision has already been made', () {
      expect(runWith('resumed').canResume, isFalse,
          reason: 'the stale row still offers resume; clicking it once the resumed run has '
              'finished spawns a duplicate run against the same checkpoint');
    });

    test('offers no replay — a replay is a fresh run and resets the codeline', () {
      expect(runWith('resumed').canReplay, isFalse,
          reason: 'isFinished is "not active and not paused", so `resumed` falls through to '
              'replay. A misclick there starts a FRESH run and hard-resets the codeline.');
    });

    test('offers no stop — it is not the run that is in flight', () {
      expect(runWith('resumed').canStop, isFalse);
    });
  });

  group('the controls that must keep working — the fix does not disable the dashboard', () {
    test('a genuinely paused run with a runId still resumes', () {
      expect(runWith('paused').canResume, isTrue);
    });

    test('a paused run WITHOUT a runId still refuses to resume', () {
      // Resuming without EPAM_RESUME_RUN launches a fresh run and resets the codeline — 2026-09-02.
      expect(runWith('paused', runId: null).canResume, isFalse);
    });

    test('a finished run still replays', () {
      expect(runWith('succeeded').canReplay, isTrue);
      expect(runWith('failed').canReplay, isTrue,
          reason: 'reproducing a failure is the entire point of a bug report');
    });

    test('a running run still stops', () {
      expect(runWith('running').canStop, isTrue);
      expect(runWith('pending').canStop, isTrue);
    });
  });
}

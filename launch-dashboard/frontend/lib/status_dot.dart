import 'package:flutter/material.dart';
import 'theme.dart';
import 'api.dart';

/// The green dot, and the two states that must never look like it.
///
/// A run that has stalled must NOT read as running: a "pending" row that never advances is
/// indistinguishable from a working one, which is the silent-failure shape this project has spent
/// two days removing. So the dot is driven by BOTH status and freshness — if the backend has not
/// heard anything for [staleAfter], it stops claiming the run is healthy.
class StatusDot extends StatelessWidget {
  final Run run;
  static const staleAfter = Duration(minutes: 10);

  const StatusDot(this.run, {super.key});

  bool get _isStale {
    if (!run.isActive) return false;
    final t = DateTime.tryParse(run.updatedAt);
    if (t == null) return false;
    return DateTime.now().toUtc().difference(t.toUtc()) > staleAfter;
  }

  Color get _colour {
    if (_isStale) return Palette.amber;
    switch (run.status) {
      case 'running':
      case 'pending':
      case 'stopping':
        return Palette.green;
      case 'paused':
        return Palette.amber;
      case 'succeeded':
        return Palette.greenDim;
      case 'dry-run':
        return Palette.muted;
      default:
        return Palette.red; // failed, stopped, and anything unrecognised
    }
  }

  String get label {
    if (_isStale) return '${run.status} — no update in ${staleAfter.inMinutes}m';
    if (run.isActive && (run.stage?.isNotEmpty ?? false)) return '${run.status} — ${run.stage}';
    return run.status;
  }

  @override
  Widget build(BuildContext context) {
    return Row(mainAxisSize: MainAxisSize.min, children: [
      Container(
        width: 9,
        height: 9,
        decoration: BoxDecoration(
          color: _colour,
          shape: BoxShape.circle,
          // Only a LIVE run glows. A finished or stalled one is flat, so a glance distinguishes
          // "working" from "was working".
          boxShadow: run.isActive && !_isStale
              ? [BoxShadow(color: _colour.withValues(alpha: 0.6), blurRadius: 7, spreadRadius: 1)]
              : null,
        ),
      ),
      const SizedBox(width: 8),
      Flexible(child: Text(label, overflow: TextOverflow.ellipsis)),
    ]);
  }
}

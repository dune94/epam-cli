import 'package:flutter/material.dart';

/// Dark background, bright green foreground.
///
/// Deliberately plain. This is an operational surface for people who want to know whether a run is
/// going — not a product demo. Every colour below carries meaning: green is healthy, amber is
/// waiting for a human, red is failed. Nothing is decorative.
class Palette {
  static const bg = Color(0xFF0B0F0C);
  static const surface = Color(0xFF121814);
  static const border = Color(0xFF1F2A22);
  static const green = Color(0xFF00E676);
  static const greenDim = Color(0xFF00A152);
  static const text = Color(0xFFD6F5E3);
  static const muted = Color(0xFF6F8578);
  static const amber = Color(0xFFFFC246);
  static const red = Color(0xFFFF5C5C);
}

ThemeData buildTheme() {
  const scheme = ColorScheme.dark(
    primary: Palette.green,
    surface: Palette.surface,
    onSurface: Palette.text,
    error: Palette.red,
  );
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: Palette.bg,
    fontFamily: 'monospace',
    textTheme: const TextTheme(
      bodyMedium: TextStyle(color: Palette.text, fontSize: 13),
      bodySmall: TextStyle(color: Palette.muted, fontSize: 12),
      titleLarge: TextStyle(color: Palette.green, fontSize: 18, fontWeight: FontWeight.w600),
    ),
    inputDecorationTheme: const InputDecorationTheme(
      filled: true,
      fillColor: Palette.surface,
      border: OutlineInputBorder(borderSide: BorderSide(color: Palette.border)),
      enabledBorder: OutlineInputBorder(borderSide: BorderSide(color: Palette.border)),
      focusedBorder: OutlineInputBorder(borderSide: BorderSide(color: Palette.green)),
      labelStyle: TextStyle(color: Palette.muted),
    ),
    checkboxTheme: CheckboxThemeData(
      fillColor: WidgetStateProperty.resolveWith(
        (s) => s.contains(WidgetState.selected) ? Palette.green : Palette.surface,
      ),
      checkColor: const WidgetStatePropertyAll(Palette.bg),
      side: const BorderSide(color: Palette.border),
    ),
  );
}

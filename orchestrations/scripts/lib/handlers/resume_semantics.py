"""resume_semantics — the Python twin of lib/resume-semantics.sh.

One declaration (config/resume-preserves.json) says what a resume keeps; this answers
resume_preserves(aspect) from it for the Python handlers. An undeclared aspect raises.
"""
import json
import os

def _preserves_file():
    here = os.path.dirname(os.path.abspath(__file__))
    return os.environ.get('EPAM_RESUME_PRESERVES_FILE') or os.path.join(here, '..', '..', '..', 'config', 'resume-preserves.json')

def is_resume():
    return bool(os.environ.get('EPAM_RESUME_RUN'))

def resume_preserves(aspect):
    with open(_preserves_file()) as f:
        declared = (json.load(f) or {}).get('preserves') or {}
    if not aspect or aspect not in declared:
        raise KeyError(f"[resume-semantics] aspect '{aspect}' is not declared in {_preserves_file()} — declare it before asking")
    return is_resume()

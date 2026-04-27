from pathlib import Path
root = Path(r'd:\CITYU\Year 4\FYP\04BESSE\BESSE\city-waste-simulation')
style = '''    <style>
      :root {
        --ink:#1a2f25;
        --ink-2:#244635;
        --panel:#9bb38f;
        --paper:#e3dfd2;
        --card:#ffffff;
        --muted:#6b7280;
        --accent:#2f6f43;
        --accent-2:#3e7d51;
        --radius-xl: 20px;
        --shadow-1: 0 12px 24px rgba(0,0,0,.12);
      }
      html, body { height: 100%; }
      body { background: var(--paper) !important; color: #1f2937 !important; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji" !important; }
      .app-header { background: var(--ink-2) !important; color: #fff !important; box-shadow: var(--shadow-1) !important; }
      .stage { background: var(--panel) !important; border-radius: 26px !important; box-shadow: var(--shadow-1) !important; border: 2px solid rgba(0,0,0,.06) !important; }
      .stage-head { background: var(--ink) !important; color: #e8f3ec !important; }
      # Avoid overriding generic rounding utility classes (buttons/modals also use rounded-*)
      .card, .role-card { background: var(--card) !important; }
      .btn-ink { background: var(--ink) !important; color:#fff !important; }
      .btn-main { background:#fff !important; color:#111827 !important; border: 2px solid #e9e5d6 !important; }
      .record-bar { background: linear-gradient(90deg, #16a34a 0%, #047857 100%) !important; }
      .status-normal { background: linear-gradient(135deg, #059669 0%, #047857 100%) !important; }
      .status-full { background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%) !important; }
      .status-overflowing { background: linear-gradient(135deg, #ef4444 0%, #b91c1c 100%) !important; }
    </style>
    <!-- GREEN-THEME-OVERRIDE -->
'''

htmls = sorted(root.glob('*.html'))
for f in htmls:
    text = f.read_text(encoding='utf-8')
    if 'GREEN-THEME-OVERRIDE' in text:
        continue
    if '</head>' in text:
        text = text.replace('</head>', style + '</head>')
        f.write_text(text, encoding='utf-8')
        print('patched', f.name)
    else:
        print('no-head', f.name)

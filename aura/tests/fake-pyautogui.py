"""Headless stand-in so the FULL /do execution path can be exercised."""
FAILSAFE = True
PAUSE = 0.0
calls = []
class _P:
    def __init__(s,x,y): s.x, s.y = x, y
def size(): return (1920, 1080)
def position(): return _P(960, 540)
def moveTo(x, y, duration=0): calls.append(('moveTo', x, y))
def click(x=None, y=None): calls.append(('click', x, y))
def doubleClick(x=None, y=None): calls.append(('doubleClick', x, y))
def rightClick(x=None, y=None): calls.append(('rightClick', x, y))
def dragTo(x, y, duration=0, button='left'): calls.append(('dragTo', x, y))
def typewrite(t, interval=0): calls.append(('type', t))
def press(k): calls.append(('press', k))
def hotkey(*k): calls.append(('hotkey', '+'.join(k)))
def scroll(n): calls.append(('scroll', n))
def screenshot():
    class I:
        def save(self, buf, format='PNG'): buf.write(b'\x89PNG\r\n\x1a\n' + b'0'*64)
    return I()

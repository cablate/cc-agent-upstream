// An agent's own picture with a transparent background is an icon, like the default
// logo, and sits in its tile at the logo's size; one opaque at its corners is a
// photo and fills the tile (an icon made to the
// logo's own measure came out larger than every other agent's in the list).
// Read once per picture from its corner pixels; until then it is not shown, so a
// picture does not jump from one size to the other.
import {reactive} from 'vue';

const shapes = reactive({});
const SIZE = 16;

function probe(url) {
  const img = new Image();
  img.onload = () => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = SIZE;
      const context = canvas.getContext('2d');
      context.drawImage(img, 0, 0, SIZE, SIZE);
      const {data} = context.getImageData(0, 0, SIZE, SIZE);
      const alpha = (x, y) => data[(y * SIZE + x) * 4 + 3];
      shapes[url] = [alpha(0, 0), alpha(SIZE - 1, 0), alpha(0, SIZE - 1), alpha(SIZE - 1, SIZE - 1)].every(a => a < 16) ? 'icon' : 'photo';
    } catch { shapes[url] = 'photo'; }
  };
  img.onerror = () => { shapes[url] = 'photo'; };
  img.src = url;
}

// 'icon', 'photo', or 'unknown' while it is being read.
export function avatarShape(url) {
  if (!url) return 'photo';
  if (!(url in shapes)) { shapes[url] = 'unknown'; probe(url); }
  return shapes[url];
}

// The picture an agent without its own shows: the CC Agent symbol, one for every agent.
export const defaultAvatar = () => '/agent-symbol-256.png';

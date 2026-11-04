// The Earth as a photograph, for the flight globe: NASA's Blue Marble (public domain,
// taken from the `three-globe` package's 4096 x 2048 copy) wrapped on the same orthographic
// camera as d3-geo's, so what's drawn over it lines up. Each pixel needs its own lookup, too
// slow on a 2D canvas, so WebGL does it and the result is copied onto the caller's canvas.
// One context and texture serve every globe, since webviews limit how many contexts a page
// can hold, and they're let go shortly after the last globe leaves.

import { geoRotation, type GeoProjection } from "d3-geo";

import imageryUrl from "@/assets/earth-blue-marble.jpg";

const VERTEX = `#version 300 es
void main() {
  gl_Position = vec4(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D earth;
uniform mat3 rotation;
uniform vec2 size;
uniform float radius;
uniform float ratio;
out vec4 color;

const float PI = 3.14159265359;
const vec3 AIR = vec3(0.36, 0.6, 1.0);

float star(vec2 cell) {
  vec3 mixed = fract(cell.xyx * 0.1031);
  mixed += dot(mixed, mixed.yzx + 33.33);
  float h = fract((mixed.x + mixed.y) * mixed.z);
  return h > 0.998 ? (h - 0.998) / 0.002 : 0.0;
}

void main() {
  vec2 p = (gl_FragCoord.xy - size * 0.5) / radius;
  float d = length(p);
  float edge = 1.5 / radius;

  vec3 space = vec3(0.012, 0.016, 0.035) + star(floor(gl_FragCoord.xy / (1.5 * ratio))) * 0.75;
  space += AIR * 0.5 * exp(-max(d - 1.0, 0.0) * 30.0);

  float z = sqrt(max(1.0 - d * d, 0.0));
  vec3 normal = vec3(p, z);
  vec3 world = normal * rotation;
  float along = atan(world.x, world.z) / (2.0 * PI);
  float v = 0.5 - asin(clamp(world.y, -1.0, 1.0)) / PI;
  // Two versions of the seam, using whichever isn't jumping here: a jump would pick
  // the smallest mipmap and draw a line down the antimeridian.
  float uA = fract(along + 0.5);
  float uB = fract(along + 1.0) - 0.5;
  vec2 uv = vec2(fwidth(uA) <= fwidth(uB) + 0.000001 ? uA : uB, v);

  vec3 ground = texture(earth, uv).rgb;
  // Close up the photo is stretched, so restore some of the contrast that loses.
  vec2 texel = 1.0 / vec2(textureSize(earth, 0));
  float stretch = 1.0 - smoothstep(0.25, 1.0, fwidth(v) / texel.y);
  if (stretch > 0.0) {
    vec3 soft = (texture(earth, uv + vec2(texel.x, 0.0)).rgb + texture(earth, uv - vec2(texel.x, 0.0)).rgb
      + texture(earth, uv + vec2(0.0, texel.y)).rgb + texture(earth, uv - vec2(0.0, texel.y)).rgb) * 0.25;
    ground = clamp(ground + (ground - soft) * 0.9 * stretch, 0.0, 1.0);
  }
  ground = pow(ground, vec3(0.86));

  // Sunlight from the upper left, the air thickening towards the Earth's edge.
  float sun = max(dot(normal, normalize(vec3(-0.45, 0.55, 0.7))), 0.0);
  vec3 lit = ground * (0.62 + 0.62 * sun);
  float haze = pow(1.0 - z, 3.0);
  lit = mix(lit, AIR, clamp(0.05 + haze * 0.55, 0.0, 1.0));

  color = vec4(mix(lit, space, smoothstep(1.0 - edge, 1.0 + edge, d)), 1.0);
}`;

/** After the last globe leaves, the image stays this long in case another is about to appear. */
const RELEASE_AFTER_MS = 15_000;

function compile(gl: WebGL2RenderingContext) {
  const program = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, VERTEX],
    [gl.FRAGMENT_SHADER, FRAGMENT],
  ] as const) {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
}

/** Where d3 sends the world's axes, as a matrix: the shader goes the other way, from the screen to the map. */
function rotationOf(projection: GeoProjection) {
  const rotate = geoRotation(projection.rotate());
  const axis = (longitude: number, latitude: number) => {
    const [lambda, phi] = rotate([longitude, latitude]).map((degrees) => (degrees * Math.PI) / 180);
    return [Math.cos(phi) * Math.sin(lambda), Math.sin(phi), Math.cos(phi) * Math.cos(lambda)];
  };
  return [...axis(90, 0), ...axis(0, 90), ...axis(0, 0)];
}

async function createEarth() {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, powerPreference: "low-power" });
  if (!gl) return null;
  const program = compile(gl);
  if (!program) return null;

  const image = new Image();
  image.src = imageryUrl;
  await image.decode();

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // Keeps the land sharp where it tilts away, near the Earth's edge.
  const anisotropy = gl.getExtension("EXT_texture_filter_anisotropic");
  if (anisotropy) gl.texParameterf(gl.TEXTURE_2D, anisotropy.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  gl.useProgram(program);

  const uniform = {
    rotation: gl.getUniformLocation(program, "rotation"),
    size: gl.getUniformLocation(program, "size"),
    radius: gl.getUniformLocation(program, "radius"),
    ratio: gl.getUniformLocation(program, "ratio"),
  };

  return {
    /** Paints the Earth and space over the whole of `ctx`. False if it can't, so the caller draws something else. */
    draw(ctx: CanvasRenderingContext2D, projection: GeoProjection) {
      if (gl.isContextLost()) return false;
      const target = ctx.canvas;
      const [centerX, centerY] = projection.translate();
      const ratio = target.width / (centerX * 2);
      if (canvas.width !== target.width || canvas.height !== target.height) {
        canvas.width = target.width;
        canvas.height = target.height;
        gl.viewport(0, 0, target.width, target.height);
      }
      gl.uniformMatrix3fv(uniform.rotation, false, rotationOf(projection));
      gl.uniform2f(uniform.size, target.width, target.height);
      gl.uniform1f(uniform.radius, projection.scale() * ratio);
      gl.uniform1f(uniform.ratio, ratio);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      ctx.drawImage(canvas, 0, 0, centerX * 2, centerY * 2);
      return true;
    },
    dispose() {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}

export type Earth = NonNullable<Awaited<ReturnType<typeof createEarth>>>;

let shared: Promise<Earth | null> | null = null;
let users = 0;
let releasing: ReturnType<typeof setTimeout> | undefined;

/** The renderer, or null where WebGL or the image isn't available. Pair it with `releaseEarth`. */
export function acquireEarth() {
  users += 1;
  clearTimeout(releasing);
  return (shared ??= createEarth().catch(() => null));
}

export function releaseEarth() {
  users -= 1;
  if (users > 0) return;
  releasing = setTimeout(() => {
    void shared?.then((earth) => earth?.dispose());
    shared = null;
  }, RELEASE_AFTER_MS);
}

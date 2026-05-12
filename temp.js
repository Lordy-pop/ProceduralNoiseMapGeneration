
        const GLSL_FUNCTIONS = {
            core: `// --- UTILITIES ---
vec2 hash22(vec2 p) {
    p = vec2(dot(p,vec2(127.1,311.7)), dot(p,vec2(269.5,183.3)));
    return -1.0 + 2.0 * fract(sin(p)*43758.5453123);
}
float hash12(vec2 p) {
    float h = dot(p,vec2(127.1,311.7));
    return fract(sin(h)*43758.5453123);
}`,
            simplex: `// --- SIMPLEX NOISE ---
float simplexNoise(vec2 p) {
    const float K1 = 0.366025404; // (sqrt(3)-1)/2;
    const float K2 = 0.211324865; // (3-sqrt(3))/6;
    vec2 i = floor(p + (p.x + p.y) * K1);
    vec2 a = p - i + (i.x + i.y) * K2;
    float m = step(a.y, a.x); 
    vec2 o = vec2(m, 1.0 - m);
    vec2 b = a - o + K2;
    vec2 c = a - 1.0 + 2.0 * K2;
    vec3 h = max(0.5 - vec3(dot(a,a), dot(b,b), dot(c,c) ), 0.0);
    vec3 n = h*h*h*h * vec3( dot(a,hash22(i+0.0)), dot(b,hash22(i+o)), dot(c,hash22(i+1.0)));
    return dot(n, vec3(70.0));
}`,
            fbm: `// --- FRACTIONAL BROWNIAN MOTION (fBm) ---
float fbm(vec2 p, int octaves, float persistence, float lacunarity) {
    float total = 0.0;
    float amplitude = 1.0;
    float maxVal = 0.0;
    vec2 st = p;
    for(int i = 0; i < 8; i++) {
        if(i >= octaves) break;
        total += simplexNoise(st) * amplitude;
        maxVal += amplitude;
        amplitude *= persistence;
        st *= lacunarity;
    }
    return (maxVal > 0.0) ? (total / maxVal) : 0.0;
}`,
            voronoi: `// --- VORONOI / CELLULAR ---
float smin(float a, float b, float k) {
    float h = clamp(0.5 + 0.5*(b-a)/k, 0.0, 1.0);
    return mix(b, a, h) - k*h*(1.0-h);
}
float voronoi(vec2 p, float sharpness, float time) {
    vec2 n = floor(p);
    vec2 f = fract(p);
    float res = 8.0;
    float sm = 1.0 - sharpness;
    for(int j=-1; j<=1; j++)
    for(int i=-1; i<=1; i++) {
        vec2 g = vec2(float(i),float(j));
        vec2 o = hash22(n + g);
        o = 0.5 + 0.5*sin(time + 6.2831*o); // Animate points
        vec2 r = g + o - f;
        float d = dot(r,r);
        if (sm > 0.01) {
            res = smin(res, d, sm * 0.5);
        } else {
            res = min(res, d);
        }
    }
    return sqrt(res);
}`,
            ridged: `// --- RIDGED MULTI-FRACTAL ---
float ridgedNoise(vec2 p, int octaves, float persistence, float lacunarity) {
    float total = 0.0;
    float amplitude = 1.0;
    float maxVal = 0.0;
    vec2 st = p;
    float weight = 1.0;
    for(int i = 0; i < 8; i++) {
        if(i >= octaves) break;
        float n = abs(simplexNoise(st));
        n = 1.0 - n;
        n *= n;
        n *= weight;
        weight = max(min(n * 2.0, 1.0), 0.0);
        total += n * amplitude;
        maxVal += amplitude;
        amplitude *= persistence;
        st *= lacunarity;
    }
    return (maxVal > 0.0) ? (total / maxVal) : 0.0;
}`,
            curl: `// --- CURL NOISE ---
vec2 curlNoise(vec2 p) {
    float eps = 0.001;
    float n1, n2, a, b;
    n1 = simplexNoise(p + vec2(0.0, eps));
    n2 = simplexNoise(p - vec2(0.0, eps));
    a = (n1 - n2) / (2.0 * eps);
    n1 = simplexNoise(p + vec2(eps, 0.0));
    n2 = simplexNoise(p - vec2(eps, 0.0));
    b = (n1 - n2) / (2.0 * eps);
    return vec2(a, -b);
}`,
            blue: `// --- BLUE NOISE (Approximation) ---
float blueNoise(vec2 p) {
    float v = hash12(p * 100.0);
    float v2 = hash12(p * 100.0 + vec2(1.0, 0.0));
    float v3 = hash12(p * 100.0 + vec2(0.0, 1.0));
    return clamp(v - (v2+v3)*0.25, 0.0, 1.0);
}`
        };

        const VERTEX_SHADER_SRC = `#version 300 es
in vec4 aPosition;
out vec2 vUv;
void main() {
    vUv = aPosition.xy * 0.5 + 0.5;
    gl_Position = aPosition;
}
`;

        class NoiseApp {
            constructor() {
                this.canvas = document.getElementById('glcanvas');
                // CRITICAL: preserveDrawingBuffer must be true for image export to work.
                this.gl = this.canvas.getContext('webgl2', { preserveDrawingBuffer: true });
                if (!this.gl) {
                    alert("WebGL 2 not supported in your browser.");
                    return;
                }

                this.state = {
                    noiseType: 'simplex',
                    outputMode: 'grayscale',
                    warpEnabled: false,
                    warpType: 'simplex',
                    warpStrength: 0.5,
                    scale: 5.0,
                    octaves: 4,
                    persistence: 0.5,
                    lacunarity: 2.0,
                    sharpness: 0.8,
                    timeSpeed: 0.2,
                    time: 0.0
                };

                this.program = null;
                this.lastTime = performance.now();

                this.initGeometry();
                this.bindUI();
                this.updateShader(); 
                requestAnimationFrame(this.render.bind(this));
            }

            initGeometry() {
                const gl = this.gl;
                const buffer = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
                const verts = new Float32Array([
                    -1, -1,  1, -1, -1,  1,
                    -1,  1,  1, -1,  1,  1
                ]);
                gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
                this.vbo = buffer;
            }

            bindUI() {
                const bindSelect = (id, prop) => {
                    const el = document.getElementById('ui-' + id);
                    el.addEventListener('change', (e) => {
                        this.state[prop] = e.target.value;
                        this.updateShader();
                        this.updateUIVisibility();
                    });
                };
                
                const bindRange = (id, prop) => {
                    const el = document.getElementById('ui-' + id);
                    const lbl = document.getElementById('lbl-' + id);
                    el.addEventListener('input', (e) => {
                        let val = parseFloat(e.target.value);
                        this.state[prop] = val;
                        lbl.innerText = (id === 'octaves') ? val : val.toFixed(2);
                        this.updateExportedCode(); 
                    });
                };

                const bindToggle = (id, prop) => {
                    const el = document.getElementById('ui-' + id);
                    el.addEventListener('change', (e) => {
                        this.state[prop] = e.target.checked;
                        this.updateShader();
                        this.updateUIVisibility();
                    });
                };

                bindSelect('noiseType', 'noiseType');
                bindSelect('outputMode', 'outputMode');
                bindSelect('warpType', 'warpType');
                bindToggle('warpEnabled', 'warpEnabled');
                bindRange('warpStrength', 'warpStrength');
                bindRange('scale', 'scale');
                bindRange('octaves', 'octaves');
                bindRange('persistence', 'persistence');
                bindRange('lacunarity', 'lacunarity');
                bindRange('sharpness', 'sharpness');
                bindRange('timeSpeed', 'timeSpeed');

                document.getElementById('btn-download').addEventListener('click', () => {
                    this.render(0, true); 
                    const dataURL = this.canvas.toDataURL('image/png');
                    const a = document.createElement('a');
                    a.href = dataURL;
                    a.download = 'noise_map.png';
                    a.click();
                });

                document.getElementById('btn-copy-glsl').addEventListener('click', (e) => {
                    navigator.clipboard.writeText(document.getElementById('codeOutput').value);
                    const orig = e.target.innerText;
                    e.target.innerText = "Copied!";
                    setTimeout(() => e.target.innerText = orig, 1500);
                });

                document.getElementById('btn-prompt-hlsl').addEventListener('click', (e) => {
                    const code = document.getElementById('codeOutput').value;
                    const prompt = `Translate the following GLSL into an HLSL Custom Function Node for a game engine: \n\n` + code;
                    navigator.clipboard.writeText(prompt);
                    const orig = e.target.innerHTML;
                    e.target.innerHTML = "Copied!";
                    setTimeout(() => e.target.innerHTML = orig, 1500);
                });

                document.getElementById('btn-prompt-csharp').addEventListener('click', (e) => {
                    const code = document.getElementById('codeOutput').value;
                    const prompt = `Convert the following GLSL algorithm into a static performant C# method: \n\n` + code;
                    navigator.clipboard.writeText(prompt);
                    const orig = e.target.innerHTML;
                    e.target.innerHTML = "Copied!";
                    setTimeout(() => e.target.innerHTML = orig, 1500);
                });

                this.updateUIVisibility();
            }

            updateUIVisibility() {
                const nt = this.state.noiseType;
                const usesFractal = ['fbm', 'ridged'].includes(nt) || 
                                    (this.state.warpEnabled && ['fbm', 'ridged'].includes(this.state.warpType));
                
                document.getElementById('group-octaves').style.display = usesFractal ? 'block' : 'none';
                document.getElementById('group-persistence').style.display = usesFractal ? 'block' : 'none';
                document.getElementById('group-lacunarity').style.display = usesFractal ? 'block' : 'none';

                const usesVoronoi = nt === 'voronoi' || (this.state.warpEnabled && this.state.warpType === 'voronoi');
                document.getElementById('group-sharpness').style.display = usesVoronoi ? 'block' : 'none';
                document.getElementById('warpGroup').style.display = this.state.warpEnabled ? 'block' : 'none';
            }

            getTypeIndex(type) {
                const map = { 'simplex': 0, 'fbm': 1, 'voronoi': 2, 'ridged': 3, 'curl': 4, 'blue': 5 };
                return map[type] || 0;
            }

            buildFragmentShader(forExport = false) {
                const s = this.state;
                let src = `#version 300 es\nprecision highp float;\n`;
                
                if (!forExport) {
                    src += `in vec2 vUv;\nout vec4 fragColor;\n`;
                }

                if (forExport) {
                    src += `
// --- SETTINGS (HARDCODED FOR EXPORT) ---
const float u_time = ${s.time.toFixed(3)};
const float u_scale = ${s.scale.toFixed(3)};
const int u_octaves = ${s.octaves};
const float u_persistence = ${s.persistence.toFixed(3)};
const float u_lacunarity = ${s.lacunarity.toFixed(3)};
const float u_sharpness = ${s.sharpness.toFixed(3)};
const float u_warpStrength = ${s.warpStrength.toFixed(3)};
`;
                } else {
                    src += `
uniform float u_time;
uniform float u_scale;
uniform int u_octaves;
uniform float u_persistence;
uniform float u_lacunarity;
uniform float u_sharpness;
uniform float u_warpStrength;
`;
                }

                src += '\\n' + GLSL_FUNCTIONS.core + '\\n';
                src += '\\n' + GLSL_FUNCTIONS.simplex + '\\n';

                const types = new Set([s.noiseType]);
                if (s.warpEnabled) types.add(s.warpType);

                if (types.has('fbm')) src += '\\n' + GLSL_FUNCTIONS.fbm + '\\n';
                if (types.has('voronoi')) src += '\\n' + GLSL_FUNCTIONS.voronoi + '\\n';
                if (types.has('ridged')) src += '\\n' + GLSL_FUNCTIONS.ridged + '\\n';
                if (types.has('curl')) src += '\\n' + GLSL_FUNCTIONS.curl + '\\n';
                if (types.has('blue')) src += '\\n' + GLSL_FUNCTIONS.blue + '\\n';

                src += `
// Helper to evaluate chosen noise map
vec3 evaluateNoise(vec2 p, int type) {
    if (type == 0) return vec3(simplexNoise(p));
`;
                if (types.has('fbm')) src += `    if (type == 1) return vec3(fbm(p, u_octaves, u_persistence, u_lacunarity));\n`;
                if (types.has('voronoi')) src += `    if (type == 2) return vec3(voronoi(p, u_sharpness, u_time));\n`;
                if (types.has('ridged')) src += `    if (type == 3) return vec3(ridgedNoise(p, u_octaves, u_persistence, u_lacunarity));\n`;
                if (types.has('curl')) src += `    if (type == 4) return vec3(curlNoise(p), 0.0);\n`;
                if (types.has('blue')) src += `    if (type == 5) return vec3(blueNoise(p));\n`;
                src += `    return vec3(0.0);
}

void main() {
    // Note: vUv is passed from vertex shader (0 to 1)
    vec2 uv = ${forExport ? 'vec2(0.5, 0.5); // Replace with your UV coordinates' : 'vUv;'}
    vec2 p = uv * u_scale;
`;

                if (s.warpEnabled) {
                    src += `
    // Domain Warping (Mixer)
    vec3 warp = evaluateNoise(p, ${this.getTypeIndex(s.warpType)});
    p += warp.xy * u_warpStrength;
`;
                }

                if (s.outputMode === 'normal') {
                    src += `
    // RGB Normal Map via Derivatives
    float eps = 0.01;
    float h = evaluateNoise(p, ${this.getTypeIndex(s.noiseType)}).r;
    float hx = evaluateNoise(p + vec2(eps, 0.0), ${this.getTypeIndex(s.noiseType)}).r;
    float hy = evaluateNoise(p + vec2(0.0, eps), ${this.getTypeIndex(s.noiseType)}).r;
    
    vec3 normal = normalize(vec3(h - hx, h - hy, 0.1));
    // Remap to [0, 1]
    normal = normal * 0.5 + 0.5;
    ${forExport ? 'vec4 fragColor =' : 'fragColor ='} vec4(normal, 1.0);
`;
                } else {
                    if (s.noiseType === 'curl') {
                        src += `
    // Grayscale (Vector representation)
    vec3 val = evaluateNoise(p, ${this.getTypeIndex(s.noiseType)});
    // Map curl vectors [-1,1] to [0,1]
    ${forExport ? 'vec4 fragColor =' : 'fragColor ='} vec4(val * 0.5 + 0.5, 1.0);
`;
                    } else {
                        src += `
    // Grayscale Output
    float val = evaluateNoise(p, ${this.getTypeIndex(s.noiseType)}).r;
    
    // Remap bounds
    int type = ${this.getTypeIndex(s.noiseType)};
    if (type == 0 || type == 1) { 
        // Simplex/fBm range is approx [-1, 1]
        val = val * 0.5 + 0.5; 
    }
    
    ${forExport ? 'vec4 fragColor =' : 'fragColor ='} vec4(vec3(val), 1.0);
`;
                    }
                }

                src += `}\n`;
                return src;
            }

            compileShader(type, source) {
                const gl = this.gl;
                const shader = gl.createShader(type);
                gl.shaderSource(shader, source);
                gl.compileShader(shader);
                if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                    console.error("Shader compile error:", gl.getShaderInfoLog(shader));
                    gl.deleteShader(shader);
                    return null;
                }
                return shader;
            }

            updateShader() {
                const gl = this.gl;
                const vs = this.compileShader(gl.VERTEX_SHADER, VERTEX_SHADER_SRC);
                const fsSource = this.buildFragmentShader(false);
                const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSource);

                if (vs && fs) {
                    const prog = gl.createProgram();
                    gl.attachShader(prog, vs);
                    gl.attachShader(prog, fs);
                    gl.linkProgram(prog);
                    
                    if (gl.getProgramParameter(prog, gl.LINK_STATUS)) {
                        if (this.program) gl.deleteProgram(this.program);
                        this.program = prog;
                        
                        this.locs = {
                            time: gl.getUniformLocation(prog, 'u_time'),
                            scale: gl.getUniformLocation(prog, 'u_scale'),
                            octaves: gl.getUniformLocation(prog, 'u_octaves'),
                            persistence: gl.getUniformLocation(prog, 'u_persistence'),
                            lacunarity: gl.getUniformLocation(prog, 'u_lacunarity'),
                            sharpness: gl.getUniformLocation(prog, 'u_sharpness'),
                            warpStrength: gl.getUniformLocation(prog, 'u_warpStrength')
                        };
                    }
                }
                this.updateExportedCode();
            }

            updateExportedCode() {
                const exportSrc = this.buildFragmentShader(true);
                document.getElementById('codeOutput').value = exportSrc;
            }

            render(now, forceSync = false) {
                const dt = (now - this.lastTime) / 1000.0;
                this.lastTime = now;
                
                this.state.time += dt * this.state.timeSpeed;
                
                if (this.state.timeSpeed > 0 && Math.random() < 0.05) {
                    this.updateExportedCode();
                }

                const gl = this.gl;
                if (!this.program) {
                    if (!forceSync) requestAnimationFrame(this.render.bind(this));
                    return;
                }

                gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
                gl.clearColor(0.0, 0.0, 0.0, 1.0);
                gl.clear(gl.COLOR_BUFFER_BIT);

                gl.useProgram(this.program);
                
                gl.uniform1f(this.locs.time, this.state.time);
                gl.uniform1f(this.locs.scale, this.state.scale);
                gl.uniform1i(this.locs.octaves, this.state.octaves);
                gl.uniform1f(this.locs.persistence, this.state.persistence);
                gl.uniform1f(this.locs.lacunarity, this.state.lacunarity);
                gl.uniform1f(this.locs.sharpness, this.state.sharpness);
                gl.uniform1f(this.locs.warpStrength, this.state.warpStrength);

                gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
                const posLoc = gl.getAttribLocation(this.program, "aPosition");
                gl.enableVertexAttribArray(posLoc);
                gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

                gl.drawArrays(gl.TRIANGLES, 0, 6);

                if (!forceSync) {
                    requestAnimationFrame(this.render.bind(this));
                }
            }
        }

        window.onload = () => {
            new NoiseApp();
        };
    
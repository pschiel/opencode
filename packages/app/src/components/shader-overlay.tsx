import { createEffect, createSignal, onCleanup, onMount } from "solid-js"

interface ShaderOverlayProps {
  enabled: boolean
  effect: "none" | "pipboy" | "atari" | "vhs"
}

export function ShaderOverlay(props: ShaderOverlayProps) {
  let canvasRef: HTMLCanvasElement | undefined
  let gl: WebGLRenderingContext | null = null
  let program: WebGLProgram | null = null
  let animationFrameId: number | null = null
  let startTime = Date.now()
  let contentCanvas: HTMLCanvasElement | undefined

  const vertexShaderSource = `
    attribute vec2 a_position;
    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `

  const fragmentShaders: Record<string, string> = {
    pipboy: `
      precision mediump float;
      uniform vec2 u_resolution;
      uniform float u_time;
      uniform sampler2D u_content;
      
      void main() {
        vec2 uv = gl_FragCoord.xy / u_resolution;
        
        // Scanlines - dark green bands
        float scanline = sin(gl_FragCoord.y * 1.5) * 0.2 + 0.8;
        
        // Bright Pip-Boy green
        vec3 green = vec3(0.1, 1.0, 0.3);
        
        // Base glow
        float glow = 0.18;
        
        // Color with scanlines
        vec3 color = green * glow * scanline;
        
        // Rectangular vignette with rounded corners
        vec2 edge = abs(uv - 0.5) * 2.0;
        
        // Rounded rectangle distance (slight corner radius)
        float radius = 0.15;
        vec2 q = edge - (1.0 - radius);
        float roundedDist = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
        
        // Border darkness
        float border = smoothstep(-0.15, 0.0, roundedDist);
        
        gl_FragColor = vec4(0.0, 0.0, 0.0, border) + vec4(color, 0.45) * (1.0 - border);
      }
    `,
    atari: `
      precision mediump float;
      uniform vec2 u_resolution;
      uniform float u_time;
      
      void main() {
        vec2 uv = gl_FragCoord.xy / u_resolution;
        
        // Very subtle scanlines
        float scanline = sin(uv.y * u_resolution.y * 1.5) * 0.02 + 0.98;
        
        // Darker royal blue background (matching Atari DOS)
        vec3 bgColor = vec3(0.06, 0.18, 0.50);
        
        // Very subtle light glow
        vec3 glowColor = vec3(0.5, 0.7, 0.9) * 0.03;
        
        vec3 color = bgColor * scanline + glowColor;
        
        gl_FragColor = vec4(color, 0.75);
      }
    `,
    vhs: `
      precision mediump float;
      uniform vec2 u_resolution;
      uniform float u_time;
      
      // Pseudo-random noise
      float rand(vec2 co) {
        return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
      }
      
      void main() {
        vec2 uv = gl_FragCoord.xy / u_resolution;
        float time = u_time * 0.001;
        
        // VHS tracking lines - horizontal bands that drift
        float trackingLine = step(0.99, rand(vec2(floor(uv.y * 20.0), floor(time * 5.0))));
        float trackingNoise = trackingLine * 0.15;
        
        // Horizontal scanlines (thicker than CRT)
        float scanline = sin(uv.y * u_resolution.y * 0.5) * 0.08;
        
        // Color bleeding / chromatic aberration
        float aberration = sin(time * 3.0) * 0.003 + 0.002;
        
        // Noise grain
        float noise = rand(uv + fract(time)) * 0.12;
        
        // Vertical sync wobble
        float wobble = sin(uv.y * 10.0 + time * 2.0) * 0.002;
        
        // Rolling bar (that dark band that rolls up the screen)
        float rollPos = fract(time * 0.1);
        float rollBar = smoothstep(rollPos - 0.05, rollPos, uv.y) * smoothstep(rollPos + 0.1, rollPos + 0.05, uv.y);
        float rollDarken = rollBar * 0.3;
        
        // Static interference bursts
        float staticBurst = step(0.98, rand(vec2(time * 10.0, 0.0))) * rand(uv + time) * 0.2;
        
        // Combine effects into a subtle color tint
        vec3 tint = vec3(0.1, 0.05, 0.15); // Slight purple/magenta VHS tint
        
        // Build the overlay
        float overlay = scanline + noise + trackingNoise + staticBurst - rollDarken;
        vec3 color = tint * 0.3 + vec3(overlay);
        
        // Edge vignette (VHS has soft edges)
        vec2 center = uv - 0.5;
        float vignette = 1.0 - dot(center, center) * 0.5;
        
        gl_FragColor = vec4(color * vignette, 0.35);
      }
    `,
    none: `
      precision mediump float;
      void main() {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
      }
    `,
  }

  function createShader(type: number, source: string): WebGLShader | null {
    if (!gl) return null
    const shader = gl.createShader(type)
    if (!shader) return null

    gl.shaderSource(shader, source)
    gl.compileShader(shader)

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error("Shader compile error:", gl.getShaderInfoLog(shader))
      gl.deleteShader(shader)
      return null
    }

    return shader
  }

  function createProgram(vertexShader: WebGLShader, fragmentShader: WebGLShader): WebGLProgram | null {
    if (!gl) return null
    const prog = gl.createProgram()
    if (!prog) return null

    gl.attachShader(prog, vertexShader)
    gl.attachShader(prog, fragmentShader)
    gl.linkProgram(prog)

    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error("Program link error:", gl.getProgramInfoLog(prog))
      gl.deleteProgram(prog)
      return null
    }

    return prog
  }

  function initShader(effect: string) {
    if (!gl || !canvasRef) return

    const vertexShader = createShader(gl.VERTEX_SHADER, vertexShaderSource)
    const fragmentShader = createShader(gl.FRAGMENT_SHADER, fragmentShaders[effect] || fragmentShaders.none)

    if (!vertexShader || !fragmentShader) return

    if (program) {
      gl.deleteProgram(program)
    }

    program = createProgram(vertexShader, fragmentShader)
    if (!program) return

    gl.useProgram(program)

    // Setup position buffer
    const positionBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)

    const positionLocation = gl.getAttribLocation(program, "a_position")
    gl.enableVertexAttribArray(positionLocation)
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0)
  }

  function captureContent() {
    if (!contentCanvas) return
    const ctx = contentCanvas.getContext("2d")
    if (!ctx) return

    // Capture current page content
    ctx.drawImage(document.body as any, 0, 0)
  }

  function render() {
    if (!gl || !program || !canvasRef) return

    const resolutionLocation = gl.getUniformLocation(program, "u_resolution")
    const timeLocation = gl.getUniformLocation(program, "u_time")

    gl.viewport(0, 0, canvasRef.width, canvasRef.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    gl.uniform2f(resolutionLocation, canvasRef.width, canvasRef.height)
    gl.uniform1f(timeLocation, Date.now() - startTime)

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    if (props.enabled) {
      animationFrameId = requestAnimationFrame(render)
    }
  }

  function resize() {
    if (!canvasRef) return
    canvasRef.width = window.innerWidth
    canvasRef.height = window.innerHeight
  }

  onMount(() => {
    if (!canvasRef) return

    gl = canvasRef.getContext("webgl")
    if (!gl) {
      console.error("WebGL not supported")
      return
    }

    resize()
    window.addEventListener("resize", resize)

    initShader(props.effect)
    if (props.enabled) {
      render()
    }
  })

  createEffect(() => {
    if (props.enabled && gl) {
      initShader(props.effect)
      startTime = Date.now()
      if (!animationFrameId) {
        render()
      }
    } else {
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId)
        animationFrameId = null
      }
    }
  })

  onCleanup(() => {
    window.removeEventListener("resize", resize)
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId)
    }
    if (gl && program) {
      gl.deleteProgram(program)
    }
  })

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100vw",
        height: "100vh",
        "pointer-events": "none",
        "z-index": 9999,
        display: props.enabled ? "block" : "none",
      }}
    />
  )
}

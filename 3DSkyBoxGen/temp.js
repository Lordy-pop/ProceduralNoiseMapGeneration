const document = {getElementById:()=>({addEventListener:()=>{}, classList:{remove:()=>{}}}), createElement:()=>({classList:{add:()=>({}), remove:()=>({}), toggle:()=>({})}, dataset:{}, style:{setProperty:()=>{}}})}; const window = {addEventListener:()=>{}}; const localStorage = {getItem:()=>null, setItem:()=>{}}; const Math = global.Math; 
  tailwind.config = {
    darkMode: 'class',
    theme: {
      extend: {
        colors: {
          cyanx:    { 300:'#67e8f9', 400:'#22d3ee', 500:'#06b6d4', 600:'#0891b2' },
          fuchsiax: { 300:'#f0abfc', 400:'#e879f9', 500:'#d946ef', 600:'#c026d3' },
          panel: '#0b1224',
          bg: '#05070f',
        },
        fontFamily: {
          sans: ['Inter', 'system-ui', 'sans-serif'],
          mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
        },
      },
    },
  };

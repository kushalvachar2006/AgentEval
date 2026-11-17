/** @type {import('tailwindcss').Config} */
// Every colour is a CSS variable (see src/index.css) so light and dark themes share one set of class names.
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;
const status = (name) => ({ fg: token(`${name}-fg`), bg: token(`${name}-bg`), dot: token(`${name}-dot`) });

export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        canvas: token('canvas'),
        surface: token('surface'),
        sunken: token('sunken'),
        line: { DEFAULT: token('line'), strong: token('line-strong') },
        ink: token('ink'),
        muted: token('muted'),
        faint: token('faint'),
        brand: { DEFAULT: token('brand'), strong: token('brand-strong'), soft: token('brand-soft'), on: token('on-brand') },
        cream: '#FFF4D6',
        link: token('link'),
        success: status('success'),
        danger: { ...status('danger'), solid: token('danger-solid') },
        warning: status('warning'),
        info: status('info'),
        code: { bg: token('code-bg'), fg: token('code-fg') },
        hero: token('hero'),
      },
      fontFamily: {
        sans: ['"IBM Plex Sans Variable"', '"IBM Plex Sans"', 'ui-sans-serif', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      // A denser scale than Tailwind's default: 14px body, 13px for tables and controls.
      fontSize: {
        xs: ['0.75rem', { lineHeight: '1rem' }],
        sm: ['0.8125rem', { lineHeight: '1.25rem' }],
        base: ['0.875rem', { lineHeight: '1.375rem' }],
        lg: ['1rem', { lineHeight: '1.5rem' }],
        xl: ['1.25rem', { lineHeight: '1.75rem' }],
        '2xl': ['1.5rem', { lineHeight: '2rem' }],
        '3xl': ['2rem', { lineHeight: '2.5rem' }],
      },
      // Radius follows hierarchy: chips < controls < panels < dialogs.
      borderRadius: { sm: '4px', DEFAULT: '6px', md: '6px', lg: '8px', panel: '10px', xl: '14px' },
      boxShadow: {
        pop: '0 10px 32px -8px rgb(var(--shadow) / 0.22), 0 2px 6px -2px rgb(var(--shadow) / 0.12)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'pop-in': { from: { opacity: '0', transform: 'translateY(6px) scale(.98)' }, to: { opacity: '1', transform: 'none' } },
        'drawer-in': { from: { transform: 'translateX(-100%)' }, to: { transform: 'none' } },
        'toast-in': { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'none' } },
        'bar-grow': { from: { transform: 'scaleX(0)' }, to: { transform: 'scaleX(1)' } },
        rise: { from: { opacity: '0', transform: 'translateY(18px)' }, to: { opacity: '1', transform: 'none' } },
        float: { '0%,100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-9px)' } },
        'spin-slow': { from: { transform: 'translate(-50%,-50%) rotate(0deg)' }, to: { transform: 'translate(-50%,-50%) rotate(360deg)' } },
        scan: { from: { top: '0%', opacity: '0' }, '10%': { opacity: '.8' }, '90%': { opacity: '.8' }, to: { top: '100%', opacity: '0' } },
        'drift-a': { '0%,100%': { transform: 'translate3d(0,0,0) scale(1)' }, '50%': { transform: 'translate3d(60px,40px,0) scale(1.15)' } },
        'drift-b': { '0%,100%': { transform: 'translate3d(0,0,0) scale(1.1)' }, '50%': { transform: 'translate3d(-70px,-30px,0) scale(.95)' } },
        'ring-pulse': { '0%': { transform: 'scale(1)', opacity: '.55' }, '100%': { transform: 'scale(1.25,2.4)', opacity: '0' } },
        marquee: { from: { transform: 'translateX(0)' }, to: { transform: 'translateX(-50%)' } },
        pop: { '0%': { opacity: '0', transform: 'scale(.6)' }, '70%': { transform: 'scale(1.1)' }, '100%': { opacity: '1', transform: 'none' } },
        blink: { '0%,49%': { opacity: '1' }, '50%,100%': { opacity: '0' } },
      },
      animation: {
        'fade-in': 'fade-in .15s ease-out',
        'pop-in': 'pop-in .18s ease-out',
        'drawer-in': 'drawer-in .22s cubic-bezier(.2,.8,.2,1)',
        'toast-in': 'toast-in .2s ease-out',
        'bar-grow': 'bar-grow .7s cubic-bezier(.2,.8,.2,1) both',
        rise: 'rise .8s cubic-bezier(.2,.8,.2,1) both',
        float: 'float 6s ease-in-out infinite',
        'spin-slow': 'spin-slow 9s linear infinite',
        scan: 'scan 5.5s linear 1.8s infinite',
        'drift-a': 'drift-a 22s ease-in-out infinite',
        'drift-b': 'drift-b 28s ease-in-out infinite',
        'ring-pulse': 'ring-pulse 2.4s ease-out infinite',
        marquee: 'marquee 38s linear infinite',
        pop: 'pop .55s ease-out both',
        blink: 'blink 1.1s steps(1) infinite',
      },
    },
  },
  plugins: [],
};
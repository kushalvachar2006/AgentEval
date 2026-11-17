export const isId = (v) => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);

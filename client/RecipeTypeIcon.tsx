import type { RecipeType } from './db.ts';

export function RecipeTypeIcon({ type, large = false }: { type: RecipeType | null; large?: boolean }) {
  return <span className={`recipe-type-icon${large ? ' recipe-type-icon-large' : ''}`} data-recipe-type={type || 'unknown'} aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {type === 'beer' ? <>
        <path d="M5 8h12v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8Z" />
        <path d="M17 10h2a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-2M8 11v7m5-7v7" />
        <path d="M5 8c-1.4-.5-1.2-2.7.5-2.9.7-2.9 4.1-3.2 5.1-.8 1.8-1.7 4.5-.3 4.2 1.6C17.8 6.1 18 8 16.5 8H5Z" />
      </> : type === 'wine' ? <>
        <path d="M5 3h14l-1.1 7.7a5.9 5.9 0 0 1-11.8 0L5 3Z" />
        <path d="M6 9c2 .7 4.1.7 6 0s4-.7 6 0M12 16.6V21m-4 0h8" />
      </> : type === 'mead' ? <>
        <path d="m12 2 3.7 2.1v4.3L12 10.5 8.3 8.4V4.1L12 2Z" />
        <path d="m7.5 10 3.7 2.1v4.3l-3.7 2.1-3.7-2.1v-4.3L7.5 10Zm9 0 3.7 2.1v4.3l-3.7 2.1-3.7-2.1v-4.3l3.7-2.1Z" />
        <path d="M12 18v3" />
      </> : <>
        <path d="M4 5.5c2.5-.9 5-.7 8 .5 3-1.2 5.5-1.4 8-.5v14c-2.5-.9-5-.7-8 .5-3-1.2-5.5-1.4-8-.5v-14Z" />
        <path d="M12 6v14" />
      </>}
    </svg>
  </span>;
}

/*
  RELAY project image search configuration.

  The browser talks only to a provider-neutral Supabase Edge Function:
    supabase/functions/project-image-search/index.ts

  After deployment, replace the placeholder below, for example:
    https://YOUR_PROJECT_REF.supabase.co/functions/v1/project-image-search

  The Pexels API key is stored only as a Supabase Edge Function secret and is
  never shipped to browser JavaScript.
*/
window.RELAY_IMAGE_SEARCH = window.RELAY_IMAGE_SEARCH || {
  endpoint: "https://YOUR_PROJECT_REF.supabase.co/functions/v1/project-image-search"
};

document.querySelectorAll('.brand-avatar img, .login-avatar img').forEach((image) => {
  image.addEventListener('error', () => {
    image.hidden = true;
    const fallback = image.parentElement.querySelector('.avatar-fallback');
    if (fallback) fallback.hidden = false;
  }, { once: true });
});

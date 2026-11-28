export function inputDevice(): 'pointer' | 'gamepad' {
  return 'pointer'
}

export function onInputDevice(_listener: () => void): () => void {
  return () => {}
}

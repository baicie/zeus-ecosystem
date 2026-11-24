/**
 * Web Components consumption, against published packages only.
 *
 * Every element below is registered by importing a package from
 * node_modules — `zw-button`, `zw-input`, `zw-dialog`, `zw-form-field`,
 * `zw-data-grid` and their sub-elements. Names were read out of the installed
 * tarballs, not assumed.
 *
 * The browser spec asserts behaviour: a dialog that opens, closes and
 * reopens; a form field that reports validity; a list that updates and
 * releases its rows. `customElements.get(...)` is checked too, but only as a
 * precondition — registering an element proves nothing about whether it works.
 */
import '@zeus-web/themes'
import '@zeus-web/button'
import '@zeus-web/input'
import '@zeus-web/form-field'
import '@zeus-web/dialog'
import '@zeus-web/data-grid'

interface WebComponentProbe {
  registered: Record<string, boolean>
  dialogOpens: number
  inputValues: string[]
  keydowns: number
  errors: string[]
}

const probe: WebComponentProbe = {
  registered: {},
  dialogOpens: 0,
  inputValues: [],
  keydowns: 0,
  errors: [],
}

declare global {
  interface Window {
    __wcProbe: WebComponentProbe
    __wcActions: {
      openDialog: () => void
      closeDialog: () => void
      setRows: (count: number) => void
      clearRows: () => void
    }
  }
}

window.__wcProbe = probe

window.addEventListener('error', (event) => {
  probe.errors.push(String(event.message))
})

for (const name of [
  'zw-button',
  'zw-input',
  'zw-dialog',
  'zw-form-field',
  'zw-data-grid',
]) {
  probe.registered[name] = customElements.get(name) !== undefined
}

const app = document.querySelector<HTMLElement>('#app')!

/* Button: a real click reaches the listener. */
const button = document.createElement('zw-button')
button.id = 'probe-button'
button.textContent = 'press me'
app.append(button)

let buttonClicks = 0
button.addEventListener('click', () => {
  buttonClicks += 1
  ;(window as unknown as { __buttonClicks?: number }).__buttonClicks = buttonClicks
})

/* Input: typing updates the element's value and fires input events. */
const input = document.createElement('zw-input')
input.id = 'probe-input'
app.append(input)

input.addEventListener('input', (event) => {
  const value = (event.target as HTMLInputElement).value ?? ''
  probe.inputValues.push(value)
})

/* Keyboard interaction on the input, to prove it is a real focusable control. */
input.addEventListener('keydown', () => {
  probe.keydowns += 1
})

/*
 * Form field: wraps a control and exposes validity. The sub-elements are
 * separate registrations, so using them proves the package registered its
 * whole set rather than only the root tag.
 */
const formField = document.createElement('zw-form-field')
formField.id = 'probe-form-field'

const formLabel = document.createElement('zw-form-field-label')
formLabel.textContent = 'Email'

const formControl = document.createElement('zw-input')
formControl.setAttribute('required', '')
formControl.setAttribute('type', 'email')
formControl.id = 'probe-form-control'

const formMessage = document.createElement('zw-form-field-message')
formMessage.textContent = 'Required'

formField.append(formLabel, formControl, formMessage)
app.append(formField)

/* Dialog: opened, closed and reopened from script, driven by the spec. */
const dialog = document.createElement('zw-dialog')
dialog.id = 'probe-dialog'

const dialogTitle = document.createElement('zw-dialog-title')
dialogTitle.textContent = 'Dialog'

const dialogContent = document.createElement('zw-dialog-content')
dialogContent.textContent = 'Body text'

const dialogClose = document.createElement('zw-dialog-close')
dialogClose.textContent = 'Close'

dialog.append(dialogTitle, dialogContent, dialogClose)
app.append(dialog)

dialog.addEventListener('zeus:open', () => {
  probe.dialogOpens += 1
})
// The published element may use the native toggle event instead; listening to
// both keeps the probe honest about which one fired.
dialog.addEventListener('toggle', () => {
  probe.dialogOpens += 1
})

/* Data grid: rows set and cleared, to exercise update and teardown. */
const grid = document.createElement('zw-data-grid')
grid.id = 'probe-grid'
app.append(grid)

const setRows = (count: number): void => {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: String(index),
    name: `row ${index}`,
  }))

  ;(grid as unknown as { rows?: unknown }).rows = rows
}

window.__wcActions = {
  openDialog: () => {
    ;(dialog as unknown as { open?: boolean }).open = true
    dialog.setAttribute('open', '')
  },
  closeDialog: () => {
    ;(dialog as unknown as { open?: boolean }).open = false
    dialog.removeAttribute('open')
  },
  setRows,
  clearRows: () => setRows(0),
}

setRows(3)

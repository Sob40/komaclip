import { Application } from "@hotwired/stimulus"

const application = Application.start()

// Configure Stimulus development experience
application.debug = false
window.Stimulus   = application
window.dispatchEvent(new Event("komaclip:stimulus-ready"))

export { application }

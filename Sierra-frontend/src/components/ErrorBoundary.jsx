import { Component } from "react";

// Keeps a failing widget (e.g. the code editor) from blanking the whole app.
export default class ErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return <div className="code-viewer-empty" role="alert">This panel failed to load: {String(this.state.error.message || this.state.error)}</div>;
    }
    return this.props.children;
  }
}

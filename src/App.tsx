import { useState, useEffect } from 'react'

function App(): JSX.Element {
  const [status, setStatus] = useState('Idle')
  const [progress, setProgress] = useState(0)
  const [username, setUsername] = useState('Player')
  const [view, setView] = useState<'LOGIN' | 'LAUNCHER'>('LOGIN')

  useEffect(() => {
    // Listen for progress updates
    const removeProgressListener = window.ipcRenderer.on('progress', (_event, { type, task, total, current }) => {
      const percentage = (current / total) * 100
      setProgress(percentage)
      setStatus(`${type}: ${task} (${Math.round(percentage)}%)`)
    })

    const removeStatusListener = window.ipcRenderer.on('status', (_event, msg) => {
      setStatus(msg)
    })

    // Listen for game close
    const removeCloseListener = window.ipcRenderer.on('game-closed', () => {
      setStatus('Game session ended')
      setProgress(0)
    })

    // Check initial Auth State (Mock check)
    window.ipcRenderer.invoke('check-auth').then((user) => {
      if (user) {
        setUsername(user.name)
        setView('LAUNCHER')
      }
    })

    return () => {
      removeProgressListener()
      removeStatusListener()
      removeCloseListener()
    }
  }, [])

  const handleMicrosoftLogin = async () => {
    setStatus('Waiting for Microsoft Login...')
    try {
      const profile = await window.ipcRenderer.invoke('login-microsoft')
      setUsername(profile.name)
      setView('LAUNCHER')
      setStatus('Logged in as ' + profile.name)
    } catch (e: any) {
      console.error(e)
      setStatus('Login Failed: ' + e.message)
    }
  }

  const handleLogout = async () => {
    await window.ipcRenderer.invoke('logout')
    setUsername('Player')
    setView('LOGIN')
    setStatus('Logged out')
  }

  const handleOfflineLogin = () => {
    if (!username) return
    setView('LAUNCHER')
    setStatus(`Offline Mode: ${username}`)
  }

  const handleLaunch = () => {
    setStatus('Initializing launch sequence...')
    window.ipcRenderer.send('launch-game', { username })
  }

  return (
    <>
      <div className="title-bar">MC Launcher Gake [v1.0.0]</div>
      <div className="container">
        {view === 'LOGIN' ? (
          <div className="card">
            <h1>WELCOME</h1>
            <p style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
              Sign in to access the secure network.
            </p>

            <button className="btn" onClick={handleMicrosoftLogin}>
              Login with Microsoft
            </button>

            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
              <div style={{ flex: 1, height: '1px', background: 'var(--border)' }}></div>
              <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>OR OFFLINE</span>
              <div style={{ flex: 1, height: '1px', background: 'var(--border)' }}></div>
            </div>

            <input
              type="text"
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <button className="btn btn-secondary" onClick={handleOfflineLogin}>
              Enter Offline
            </button>
            <div className="error-msg">{status !== 'Idle' ? status : ''}</div>
          </div>
        ) : (
          <div className="card">
            <h1>{username}</h1>
            <div style={{
              width: '60px', height: '60px',
              background: '#333', borderRadius: '50%', margin: '0 auto',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: '2px solid var(--primary)'
            }}>
              <img
                src={`https://minotar.net/avatar/${username}/50.png`}
                alt="Skin"
                onError={(e) => e.currentTarget.style.display = 'none'}
                style={{ borderRadius: '50%' }}
              />
            </div>

            <div style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: '11px', marginTop: '5px' }}>
              <div style={{ opacity: 0.6 }}>Static Token: ACTIVE</div>
              Identity: <span style={{ color: (status.includes('Offline') || !status.includes('Logged in')) ? '#ffcc00' : '#00ff88' }}>
                {(status.includes('Offline') || !status.includes('Logged in')) ? 'Unprotected (Offline)' : 'Protected (Microsoft)'}
              </span>
            </div>

            <button className="btn" onClick={handleLaunch}>
              LAUNCH MODPACK
            </button>
            <button className="btn btn-secondary" onClick={handleLogout} style={{ marginTop: '10px' }}>
              Hard Reset / Switch Account
            </button>
          </div>
        )}
      </div>

      <div className="status-bar">
        <span>{status}</span>
        <span>v1.0.0</span>
        <div className="progress-bar" style={{ width: `${progress}%` }}></div>
      </div>
    </>
  )
}

export default App

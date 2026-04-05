import { getPacScript } from 'Background/pac'

import browser from './browser-api'
import registry from './registry'

const redactProxyServerURI = (uri = '') =>
  uri.replace(/^([^@]+)@/, '<redacted>@')

const previewPacScript = (pacData = '') =>
  pacData
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)

class ProxyManager {
  async getProxyingRules () {
    const {
      proxyServerURI,
      customProxyProtocol,
      customProxyServerURI,
      localProxyURI,
    } = await browser.storage.local.get([
      'proxyServerURI',
      'customProxyProtocol',
      'customProxyServerURI',
      'localProxyURI',
    ])

    console.info('[ProxyManager] Loaded proxy settings snapshot', {
      hasProxyServerURI: Boolean(proxyServerURI),
      customProxyProtocol,
      customProxyServerURI: redactProxyServerURI(customProxyServerURI),
      localProxyURI: redactProxyServerURI(localProxyURI),
    })

    // When Censor Tracker Proxy Server is used
    if (localProxyURI) {
      console.log(`Using local proxy server: ${localProxyURI}`)
      return {
        proxySource: 'local',
        proxyServerProtocol: 'SOCKS5',
        proxyServerURI: localProxyURI,
      }
    }

    if (
      customProxyServerURI &&
      customProxyProtocol
    ) {
      return {
        proxySource: 'custom',
        proxyServerProtocol: customProxyProtocol,
        proxyServerURI: customProxyServerURI,
      }
    }
    return {
      proxySource: 'default',
      proxyServerProtocol: 'HTTPS',
      proxyServerURI,
    }
  }

  async requestIncognitoAccess () {
    if (browser.isFirefox) {
      const isAllowedIncognitoAccess =
        await browser.extension.isAllowedIncognitoAccess()

      if (!isAllowedIncognitoAccess) {
        const actionApi = chrome.action || chrome.browserAction

        await actionApi.setBadgeText({ text: '✕' })
        await browser.storage.local.set({
          privateBrowsingPermissionsRequired: true,
        })
        console.info('Private browsing permissions requested.')
      }
    }
  }

  async grantIncognitoAccess () {
    if (browser.isFirefox) {
      await browser.browserAction.setBadgeText({ text: '' })
      await browser.storage.local.set({
        privateBrowsingPermissionsRequired: false,
      })
    }
  }

  async setProxy () {
    const config = {}
    const domains = await registry.getDomains()

    if (domains.length === 0) {
      console.error('No domains to proxy, aborting...')
      await this.removeProxy()
      return false
    }

    const {
      proxySource,
      proxyServerURI,
      proxyServerProtocol,
    } = await this.getProxyingRules()

    const pacData = getPacScript({
      domains,
      proxyServerURI,
      proxyServerProtocol,
    })

    console.info('[ProxyManager] Preparing proxy config', {
      browser: browser.isFirefox ? 'firefox' : 'chrome',
      proxySource,
      proxyServerProtocol,
      proxyServerURI: redactProxyServerURI(proxyServerURI),
      domainsCount: domains.length,
      domainsPreview: domains.slice(0, 10),
      pacPreview: previewPacScript(pacData),
    })

    if (browser.isFirefox) {
      const blob = new Blob([pacData], {
        type: 'application/x-ns-proxy-autoconfig',
      })

      config.value = {
        proxyType: 'autoConfig',
        autoConfigUrl: URL.createObjectURL(blob),
      }
    } else {
      config.scope = 'regular'
      config.value = {
        mode: 'pac_script',
        pacScript: {
          data: pacData,
          mandatory: false,
        },
      }
    }

    try {
      const currentSettings = await browser.proxy.settings.get({})

      console.info('[ProxyManager] Proxy settings before set', {
        levelOfControl: currentSettings.levelOfControl,
        mode: currentSettings.value?.mode,
      })

      await browser.proxy.settings.set(config)
      const updatedSettings = await browser.proxy.settings.get({})

      console.info('[ProxyManager] Proxy settings after set', {
        levelOfControl: updatedSettings.levelOfControl,
        mode: updatedSettings.value?.mode,
      })
      await this.enableProxy()
      await this.grantIncognitoAccess()
      console.warn('PAC has been set successfully!')
      return true
    } catch (error) {
      console.error('[ProxyManager] PAC could not be set', {
        error: error?.message || String(error),
        stack: error?.stack,
        configMode: config.value?.mode,
        proxySource,
        proxyServerProtocol,
        proxyServerURI: redactProxyServerURI(proxyServerURI),
      })
      await this.disableProxy()
      await this.requestIncognitoAccess()
      return false
    }
  }

  async removeProxy () {
    await browser.proxy.settings.clear({})
    console.warn('Proxy settings removed.')
  }

  async alive () {
    const { proxyIsAlive } =
      await browser.storage.local.get({ proxyIsAlive: true })

    return proxyIsAlive
  }

  async ping () {
    const usingCustomProxy = await this.usingCustomProxy()

    if (!usingCustomProxy) {
      const { proxyPingURI } = await browser.storage.local.get('proxyPingURI')

      fetch(`https://${proxyPingURI}`, {
        method: 'POST',
        headers: {
          'Content-type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify({
          type: 'ping',
        }),
      }).catch(() => {
        // We don't care about the result.
        console.log(`Pinged ${proxyPingURI}!`)
      })
    }
  }

  async usingCustomProxy () {
    const { useOwnProxy } =
      await browser.storage.local.get({
        useOwnProxy: false,
      })

    return useOwnProxy
  }

  async isEnabled () {
    const { useProxy } = await browser.storage.local.get({ useProxy: true })

    return useProxy
  }

  async enableProxy () {
    console.log('Proxying enabled.')
    await browser.storage.local.set({ useProxy: true, proxyIsAlive: true })
  }

  async disableProxy () {
    console.warn('Proxying disabled.')
    await browser.storage.local.set({ useProxy: false })
  }

  async controlledByOtherExtensions () {
    const { levelOfControl } = await browser.proxy.settings.get({})

    return levelOfControl === 'controlled_by_other_extensions'
  }

  async controlledByThisExtension () {
    const { levelOfControl } = await browser.proxy.settings.get({})

    return levelOfControl === 'controlled_by_this_extension'
  }

  async takeControl () {
    const self = await browser.management.getSelf()
    const extensions = await browser.management.getAll()

    for (const { id, name, permissions } of extensions) {
      if (permissions.includes('proxy') && name !== self.name) {
        console.warn(`Disabling ${name}...`)
        await browser.management.setEnabled(id, false)
      }
    }
  }

  async removeCustomProxy () {
    await browser.storage.local.set({
      useOwnProxy: false,
    })
    await browser.storage.local.remove([
      'customProxyProtocol',
      'customProxyServerURI',
    ])
  }

  async removeLocalProxy () {
    await browser.storage.local.set({ useLocalProxy: false })
    await browser.storage.local.remove(['localProxyURI'])
  }

  async removeBadProxies () {
    await browser.storage.local.set({ badProxies: [] })
  }

  async getBadProxies () {
    const { badProxies } =
      await browser.storage.local.get({ badProxies: [] })

    return badProxies
  }
}

export default new ProxyManager()

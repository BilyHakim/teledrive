import { Api } from '@mgilangjanuar/telegram'
import axios from 'axios'
import { Request, Response } from 'express'
import moment from 'moment'
import { Files } from '../../model/entities/Files'
import { Usages } from '../../model/entities/Usages'
import { Users as Model } from '../../model/entities/Users'
import { Redis } from '../../service/Cache'
import { buildSort, buildWhereQuery } from '../../utils/FilterQuery'
import { markdownSafe } from '../../utils/StringParser'
import { Endpoint } from '../base/Endpoint'
import { Auth, AuthMaybe } from '../middlewares/Auth'
import { AuthKey } from '../middlewares/Key'

@Endpoint.API()
export class Users {

  @Endpoint.GET({ middlewares: [Auth] })
  public async search(req: Request, res: Response): Promise<any> {
    const { username, limit } = req.query
    if (!username) {
      throw { status: 400, body: { error: 'Username is required' } }
    }
    const data = await req.tg.invoke(new Api.contacts.Search({
      q: username as string,
      limit: Number(limit) || 10
    }))
    return res.send({ users: data.users })
  }

  @Endpoint.GET('/me/usage', { middlewares: [AuthMaybe] })
  public async usage(req: Request, res: Response): Promise<any> {
    let usage = await Usages.findOne({ where: { key: req.user ? `u:${req.user.id}` : `ip:${req.headers['cf-connecting-ip'] as string || req.ip}` } })
    if (!usage) {
      usage = new Usages()
      usage.key = req.user ? `u:${req.user.id}` : `ip:${req.headers['cf-connecting-ip'] as string || req.ip}`
      usage.usage = '0'
      usage.expire = moment().add(1, 'day').toDate()
      await usage.save()
    }

    if (new Date().getTime() - new Date(usage.expire).getTime() > 0) {   // is expired
      usage.expire = moment().add(1, 'day').toDate()
      usage.usage = '0'
      await usage.save()
    }

    return res.send({ usage })
  }

  @Endpoint.GET('/', { middlewares: [Auth] })
  public async find(req: Request, res: Response): Promise<any> {
    const { sort, offset, limit, ...filters } = req.query
    const [users, length] = await Model.createQueryBuilder('users')
      .select('users.username')
      .where(buildWhereQuery(filters) || 'true')
      .skip(Number(offset) || undefined)
      .take(Number(limit) || undefined)
      .orderBy(buildSort(sort as string))
      .getManyAndCount()
    return res.send({ users, length })
  }

  @Endpoint.PATCH('/me/settings', { middlewares: [Auth] })
  public async settings(req: Request, res: Response): Promise<any> {
    const { settings } = req.body
    // if (settings.theme === 'dark' && (!req.user.plan || req.user.plan === 'free') && moment().format('l') !== '2/2/2022') {
    //   throw { status: 402, body: { error: 'You need to upgrade your plan to use dark theme' } }
    // }
    // if (settings.saved_location && (!req.user.plan || req.user.plan === 'free') && moment().format('l') !== '2/2/2022') {
    //   throw { status: 402, body: { error: 'You need to upgrade your plan to use this feature' } }
    // }
    req.user.settings = {
      ...req.user.settings || {},
      ...settings
    }
    await Model.update(req.user.id, req.user)
    await Redis.connect().del(`auth:${req.authKey}`)
    return res.send({ settings: req.user?.settings })
  }

  @Endpoint.POST('/me/delete', { middlewares: [Auth] })
  public async remove(req: Request, res: Response): Promise<any> {
    const { reason, agreement } = req.body
    if (agreement !== 'permanently removed') {
      throw { status: 400, body: { error: 'Invalid agreement' } }
    }
    if (reason && process.env.TG_BOT_TOKEN && process.env.TG_BOT_OWNER_ID) {
      await axios.post(`https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}/sendMessage`, {
        chat_id: process.env.TG_BOT_OWNER_ID,
        parse_mode: 'Markdown',
        text: `😭 ${markdownSafe(req.user.name)} (@${markdownSafe(req.user.username)}) removed their account.\n\nReason: ${markdownSafe(reason)}\n\nfrom: \`${markdownSafe(req.headers['cf-connecting-ip'] as string || req.ip)}\`\ndomain: \`${req.headers['authority'] || req.headers.origin}\`${req.user ? `\nplan: ${req.user.plan}${req.user.subscription_id ? `\npaypal: ${req.user.subscription_id}` : ''}${req.user.midtrans_id ? `\nmidtrans: ${req.user.midtrans_id}` : ''}` : ''}`
      })
    }
    await Files.delete({ user_id: req.user.id })
    await Model.delete(req.user.id)
    const success = await req.tg.invoke(new Api.auth.LogOut())
    return res.clearCookie('authorization').clearCookie('refreshToken').send({ success })
  }

  @Endpoint.POST('/me/paymentSync', { middlewares: [Auth] })
  public async paymentSync(req: Request, res: Response): Promise<any> {
    type Payment = { subscription_id?: string, midtrans_id?: string, plan?: string }
    let result: Payment = null
    try {
      const { data } = await axios.get<{ payment: Payment }>(`https://teledriveapp.com/api/v1/users/${req.user.tg_id}/payment`, {
        headers: { token: process.env.UTILS_API_KEY }
      })
      if (data.payment.plan && data.payment.plan !== 'free') {
        result = data.payment
      }
    } catch (error) {
      // ignore
    }
    if (!result) {
      try {
        const { data } = await axios.get<{ payment: Payment }>(`https://us.teledriveapp.com/api/v1/users/${req.user.tg_id}/payment`, {
          headers: { token: process.env.UTILS_API_KEY }
        })
        if (data.payment.plan && data.payment.plan !== 'free') {
          result = data.payment
        }
      } catch (error) {
        // ignore
      }
    }
    if (!result) {
      try {
        const { data } = await axios.get<{ payment: Payment }>(`https://ge.teledriveapp.com/api/v1/users/${req.user.tg_id}/payment`, {
          headers: { token: process.env.UTILS_API_KEY }
        })
        if (data.payment.plan && data.payment.plan !== 'free') {
          result = data.payment
        }
      } catch (error) {
        // ignore
      }
    }
    if (result) {
      req.user.subscription_id = result?.subscription_id
      req.user.midtrans_id = result?.midtrans_id
      req.user.plan = result?.plan as any
      await Model.update(req.user.id, req.user)
      await Redis.connect().del(`auth:${req.authKey}`)
    }
    return res.status(202).send({ accepted: true })
  }

  @Endpoint.GET('/:tgId/payment', { middlewares: [AuthKey] })
  public async payment(req: Request, res: Response): Promise<any> {
    const { tgId } = req.params
    const user = await Model.findOne({ where: { tg_id: tgId } })
    if (!user) {
      throw { status: 404, body: { error: 'User not found' } }
    }
    return res.send({ payment: {
      subscription_id: user.subscription_id,
      midtrans_id: user.midtrans_id,
      plan: user.plan
    } })
  }

  @Endpoint.GET('/:username/:param?', { middlewares: [Auth] })
  public async retrieve(req: Request, res: Response): Promise<any> {
    const { username, param } = req.params
    if (param === 'photo') {
      const file = await req.tg.downloadProfilePhoto(username, { isBig: false })
      if (!file?.length) {
        return res.redirect('https://upload.wikimedia.org/wikipedia/commons/7/7c/Profile_avatar_placeholder_large.png')
      }
      res.setHeader('Cache-Control', 'public, max-age=604800')
      res.setHeader('ETag', Buffer.from(file).toString('base64').slice(10, 50))
      res.setHeader('Content-Disposition', `inline; filename=${username === 'me' ? req.user.username : username}.jpg`)
      res.setHeader('Content-Type', 'image/jpeg')
      res.setHeader('Content-Length', file.length)
      res.write(file)
      return res.end()
    }

    const user = username === 'me' || username === req.user.username ? req.user : await Model.findOne({ where: [
      { username },
      { id: username }] })
    if (!user) {
      throw { status: 404, body: { error: 'User not found' } }
    }

    return res.send({ user })
  }
}